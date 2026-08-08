# Milestones 3–5 review — audio, queue, and 999 FM

**Date:** 2026-08-08
**Reviewer hat:** Audio owner, then Command owner, then Integration owner
**Scope:** `audio/*`, `core/queue.js`, `bot/pending.js`, the playback commands, and the radio relay.

> **Read this first.** No Discord credentials were available for this build — no bot token, no test
> guild, no voice channel. The **embed critic** and the **playback critic** both require watching and
> listening to a real session, and neither was run. This document is a code and structural review
> plus the offline evidence. It is not a substitute for those passes, and Milestones 3, 4 and 5
> **do not exit** on it. See [Not verified](#not-verified) below.

---

## Defects found and fixed

### D-6 — A late FFmpeg failure skipped a second track (**Critical**, fixed)

`createSource`'s `onError` callback advanced the queue unconditionally. FFmpeg reports failure
asynchronously, so an error belonging to a track the listener had *already skipped past* arrived
after the player had moved on — and skipped again.

**Observed:** play tracks 1, 2, 3 → skip to 2 → track 1's FFmpeg reports a non-zero exit → the
player advances to track 3. Track 2 is silently consumed without ever playing.

This is the "silent failure" class: audio just moves on, the now-playing embed agrees with itself,
and nothing in the log says a track was dropped. Seeking had the same shape — the seek kills the old
FFmpeg, whose death then looked like a decode failure and skipped the track being seeked.

**Fix:** every resource start takes a monotonic token. A source's `onError` returns early unless its
token is still the current one.

**Regression tests:** guild-player.test.mjs → "a stale source failing after a skip does not skip a
second track" and "a stale source failing after a seek does not skip the track".

### D-7 — The requester mention rendered as raw markup (**Major**, fixed)

`queuedEmbed` put the requester in the embed **footer**. Discord does not render mentions in footer
text, so every `play` reply showed a literal `<@1040000000000000003>` instead of a name.

Worth stating plainly: this would have been caught instantly by the embed critic — which is exactly
the pass that could not run. It was found by reading the code against Discord's rendering rules, not
by looking at a screenshot, and there may be more of this class that reading did not catch.

**Fix:** the requester moved to the description, where mentions render. The command now passes a raw
user id rather than a pre-formatted mention.

**Regression test:** embeds.test.mjs → "the requester mention is placed where Discord will render
it".

### D-8 — `radio stop` restarted the interrupted track from zero (**Minor**, fixed)

Entering radio mode suspended the queue correctly, but resuming rebuilt the interrupted track's
source with no seek offset — so a listener 3 minutes into a 4-minute song got the whole song again.

**Fix:** the elapsed position is stamped when the queue is suspended and used as the seek offset on
resume. `stopRadio` now also returns `resumedAtSeconds`.

**Regression test:** guild-player.test.mjs → "resuming picks the track up where it was interrupted,
not from zero".

---

## Checked and found clean (offline)

All of the following are asserted by tests against fake voice primitives — a fake `AudioPlayer`, a
fake connection, and a source factory that records instead of spawning FFmpeg.

**State machine**
- Advance-on-idle across all three loop modes; `track` loop replays without touching the queue;
  `queue` loop returns the finished track to the back.
- A user `skip` clears a `track` loop for that advance only, and leaves the mode set. Without this,
  skip under track-loop replays the same song and reads as a broken button.
- An empty queue goes idle rather than replaying.
- Seek restarts the source at the offset, destroys the previous one, and elapsed time accounts for
  the offset.
- Volume applies to the live resource, clamps to 0–200, and survives a track change.
- Teardown destroys the source and the connection, clears the queue, and is idempotent.

**Concurrency** — the case the brief calls out specifically:
- Two simultaneous `play` commands in one guild produce **exactly one join**, one started source,
  and two queue entries in deterministic order.
- Six concurrent enqueues all land, exactly once each, with one join.

**Multi-user disambiguation** — the other case called out specifically:
- User 2 typing a number while user 1 has a prompt open does **not** resolve user 1's prompt, and
  user 1's prompt stays open.
- Two users hold prompts simultaneously and each resolves its own.
- A prompt expires, fires its expiry callback, removes its entry *and its timer*, and no longer
  resolves. Nothing accumulates.
- A second prompt from the same user replaces the first rather than stacking.

**Guild isolation** (`registry.test.mjs`)
- Guild A's skip, volume and loop leave B's current track, volume, loop mode and queue byte-identical.
- Destroying A leaves B playing and removes only A's registry entry.
- One guild on the station and one on a queue coexist; `radioCount` tracks accurately.
- Concurrent commands across two guilds do not interleave; one join per guild, not per command.

**Radio**
- The `http://` → `https://` upgrade, including fallbacks for absent, malformed, and protocol-relative
  URLs. Asserted against the captured live payload, which is still cleartext.
- Degraded detection for `is_live: false`, a non-playing `state`, and `stale_seconds > 60`, each with
  a reason naming the specific signal rather than a generic "offline".
- **One poller for the process**: five subscribed guilds produce one poller, asserted on the exported
  instance counter rather than by reading log output. Polling stops when the last guild unsubscribes.
- Local clock extrapolation advances the position between polls and never runs past the track's own
  duration — the bar moves smoothly instead of jumping every fifteen seconds.
- A failed poll degrades the embed and does not throw or stop audio.
- `seek`, `loop`, `skip`, `shuffle` and queue edits all refuse in radio mode with an explanation over
  twenty characters long — asserted, so a future silent no-op fails the build. `pause`, `volume` and
  `stop` remain valid.

**FFmpeg arguments** (pure, asserted exactly)
- Reconnect flags and `-ss` both precede `-i`; output seeking would be a silent performance bug.
- `-f s16le -ar 48000 -ac 2` to `pipe:1`; `-analyzeduration 0`.
- A fractional seek is floored, a negative or `NaN` seek emits no `-ss` at all.
- No `undefined` or empty entries in any argv.

---

## Not verified

These require a live gateway and were **not run**. Nothing below should be reported as working.

| Pass / metric | Status |
|---|---|
| Embed critic — screenshots in Discord light **and** dark themes | **not run.** D-7 shows this pass had real defects to find. |
| Playback critic — 10-minute listening session, gap length, stutter, skip responsiveness | **not run** |
| `npm run verify:voice` — Ready < 10 s, Playing < 4 s, zero Buffering re-entries, `playbackDuration` ≥ 29,000 ms | **not run**, no report in `evidence/` |
| `npm run verify:voice -- --radio` — audible station | **not run** |
| `npm run verify:voice -- --guilds 2` — live isolation matrix | **not run** (structural equivalent covered offline) |
| Gapless-enough advance (< 1.5 s between tracks) | **not measured** |
| Audible confirmation that the station plays at all | **not confirmed** |

The scripts to produce every one of these are written, assert rather than merely record, and exit
non-zero on failure. They need `DISCORD_TOKEN`, `TEST_GUILD_ID` and `TEST_VOICE_CHANNEL_ID`.

## Exit gate

| Milestone | Gate | Status |
|---|---|---|
| M3 | First audio < 4 s, zero buffering re-entries, embed critic complete | **not met** — unmeasured, critic not run |
| M4 | Gapless advance, no duplicate joins, disambiguation correct, playback critic clean | **partially met** — concurrency and disambiguation proven offline; gap and critic outstanding |
| M5 | Station audible, bar advances smoothly, polling stops, clear refusals | **partially met** — everything except audibility proven offline |

**These milestones do not exit.** The code is complete and the offline evidence is strong, but three
of the four gates are observational and the observations were not made.
