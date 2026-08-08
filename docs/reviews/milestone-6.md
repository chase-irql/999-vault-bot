# Milestone 6 review — resilience critic

**Date:** 2026-08-08
**Reviewer hat:** Integration owner
**Method:** Each failure case named in the build brief was reproduced where it could be reproduced
deterministically, and the **observed** behaviour recorded against the **specified** behaviour. Cases
needing a live gateway are marked and were not run.

The offline half is `test/resilience.test.mjs`, which reproduces the archive and voice-state failures
as tests rather than as a one-off session — so they stay reproduced on every commit.

---

## D-9 — The retry policy was dead code (**Critical**, fixed)

The single most valuable finding of this pass, and it was invisible to every other test.

`api/client.js` decides whether to retry with:

```js
error.status === 429 || error.status >= 500
```

`ApiError` was constructed with `{ status, statusText, route, retryAfter }`, but `AppError` put all
of those under `this.details`. **`error.status` was always `undefined`.** Every archive 5xx, every
429, and every timeout therefore failed on the *first* attempt. The configured budget of four
attempts, the exponential backoff, and the `Retry-After` handling were all unreachable code.

**Observed before the fix:** a `503` from `/songs/` produced exactly **1** HTTP request and an
immediate failure.
**Specified:** 4 attempts with exponential backoff honouring `Retry-After`.

This is a silent-failure defect: nothing throws, nothing logs a warning, and the bot simply gives up
on a transient blip that a single retry would have survived. It was found by writing a test that
counted requests instead of one that asserted "it eventually failed".

**Fix:** `AppError` now hoists details onto the instance — matching the desktop client's
`Object.assign(this, details)`, which is where the semantics were ported from — while still keeping
`this.details`. Existing keys are never shadowed.

**Observed after the fix:** `503` produces **4** requests; a 5xx that recovers on attempt 3 produces
3; `Retry-After` is honoured; a `404` is **not** retried (1 request), because it will not become a
200.

**Regression tests:** `resilience.test.mjs` → the four cases above, asserted on a request counter.

---

## Failure matrix — observed vs specified

| Case | Specified | Observed | Verdict |
|---|---|---|---|
| Invoker not in a voice channel | `UserError`, no join attempt | `UserError`; `voice.connections.length === 0` — asserted, not inferred | **matches** |
| Missing `Connect`/`Speak` | Name the permission and the channel | `VoiceError`: "I need the Speak permission in **Studio**."; no connection attempted | **matches** |
| Both permissions missing | — | "I need the Connect and Speak permissions in …" | **matches** |
| Archive 5xx | 4 attempts, exponential backoff, `Retry-After` | 4 requests; recovers mid-sequence; `Retry-After` honoured | **matches** *(after D-9)* |
| Archive 429 | Retry honouring `Retry-After` | Retried | **matches** *(after D-9)* |
| Archive 404 | — | 1 request, no retry | **matches** |
| Archive unreachable (DNS/connection) | Retry then surface cleanly | `TypeError` retried 4×, then surfaced; user text names no URL or path | **matches** |
| FFmpeg exits non-zero | stderr at debug, skip the track, report once | Skips to the next track; stderr captured (bounded to 4 KB) and logged at debug | **matches** |
| FFmpeg fails *late*, after a skip or seek | — (unspecified) | **Was** skipping a second track. Fixed — see D-6 in [milestone-3-5](milestone-3-5.md) | **fixed** |
| Two `play` commands within 100 ms | One join, two queue entries, deterministic order | Exactly one join, one started source, two entries in order; six concurrent enqueues all land once | **matches** |
| Bot dragged to another channel | Follow it, keep playing | `channelId` updates, source not destroyed, current track unchanged | **matches** |
| Bot disconnected from voice | Destroy that guild's player | Player destroyed; the other guild's player untouched | **matches** |
| Two users, one disambiguation prompt | User 2's number must not resolve user 1's prompt | Returns `false`; user 1's prompt stays open and still resolves | **matches** |
| Disambiguation timeout | Expire silently, clean up, do not leak listeners | Entry **and** timer removed; a later reply is not consumed | **matches** |
| Station stream drops | Reconnect 2/4/8/16/30 s, max 5, then one message | Schedule implemented and unit-tested; **live drop not observed** | **partial** |
| Bot alone in channel | Leave after `IDLE_DISCONNECT_MS`, clear queue, log | Timer armed/disarmed by the voice-state watcher; **live expiry not observed** | **partial** |
| Voice `Disconnected` | `entersState(Signalling\|Connecting, 5000)`, else destroy | Implemented; **live disconnect not observed** | **not run** |
| Killing the network mid-track | Recover or skip cleanly | **not run** — needs a live stream | **not run** |
| Revoking `Speak` mid-playback | Surface the error | **not run** — needs a live guild | **not run** |
| Dragging into a full channel | Surface Discord's error, do not retry forever | **not run** | **not run** |

---

## Also checked and found clean

- **Token exposure.** The redacting logger scrubs the token pattern from messages, nested fields,
  error messages and stack traces, and survives circular references. `npm run precommit` blocks a
  staged `.env`, any staged media file, a staged blob over 2 MB, and any added line matching the
  token pattern. It has already blocked one real commit in this repo's history — the token-shaped
  fixture in the redaction test — which was fixed by removing the literal rather than by adding an
  exception to the scanner.
- **No lyric text anywhere.** The archive returns `lyrics` and `synced_lyrics` inline on every song
  record. The canonical Song shape is built field by field and has no lyric field, so nothing
  downstream can render one; the 145-record fixture corpus was captured with both fields stripped;
  and a canary string pushed through the normalizer and through the `song` command does not appear in
  the output. Data and code path both covered.
- **Unhandled rejections do not kill the process.** `index.js` logs them loudly and continues —
  dropping every guild's audio because one archive promise lost its handler is worse than the bug it
  reports. An uncaught exception shuts down cleanly, non-zero, with a 5-second hard deadline so a
  wedged voice connection cannot hold the process open.
- **Architecture rules hold.** The import-boundary test passes: commands import no `discord.js`, no
  `@discordjs/voice`, no HTTP, no `audio/source.js`; `api/*` imports nothing from `bot/` or `audio/`;
  the pure modules use no timers, no `Math.random`, no `fetch`; only the logger calls `console.*`;
  only `index.js` reads `process.env`. That last rule caused a real change during M1 — `config.js`
  had `process.env` as a default parameter, and the default was removed rather than the rule weakened.

## Not run

No Discord credentials were available for this build. The following need a live gateway and were
**not** performed: the 60-minute mixed session, the live disconnect/reconnect cases, network kill
mid-track, mid-playback permission revocation, the full-channel case, embed screenshots in both
themes, and the live two-guild isolation matrix.

`scripts/verify-voice.mjs` implements the timing and isolation assertions and writes a JSON report to
`evidence/`. `evidence/` is empty; that is the honest state, not an oversight.

## Exit gate

| Requirement | Status |
|---|---|
| Zero critical defects | **met** — D-9 and D-6 found and fixed, with regression tests |
| Zero reproducible major defects in the primary flow | **met** — D-7 fixed |
| `npm run verify` green on the dev machine | **met** — 408 tests |
| CI green on Node 22 and 24 | **pending first push run** |
| Both voice smoke tests green with committed reports | **not met** — not run |
| 60-minute session with no unhandled rejections | **not met** — not run |
| Every enumerated failure case has an *observed* behaviour | **not met** — 5 of 20 unobserved |

**Milestone 6 does not exit.** The code is complete and 15 of the 20 enumerated failure cases have
observed, recorded behaviour. The remaining five, and all of the audio-timing evidence, require
credentials this build did not have.
