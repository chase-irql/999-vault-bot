# Known issues

Real defects and real limitations, with reproductions. Written plainly. Severity uses the project
gate: **Critical** = crash, wrong audio, token exposure, or silent failure; **Major** =
reproducible wrong behaviour in a primary flow; **Minor** = cosmetic or rare-path.

Items marked **Unverified** are not claims that something is broken — they are things this build
has *not* been able to observe, and saying so is the point.

---

## Open

### KI-1 — Native Opus does not build on Node 26 (Minor, environmental)

`@discordjs/opus@0.10.0` publishes no prebuild for `NODE_MODULE_VERSION 147`, and compiling from
source fails on the development machine.

**Reproduce:** on Node 26.3.1 / Windows 11, move `@discordjs/opus` back into `dependencies` and run
`npm ci`. The install fails with `gyp ERR! ... MSBuild.exe failed with exit code: 1`.

**Mitigation:** it is an `optionalDependency`; `opusscript` is a required pure-JS fallback and is
what actually runs here. See [ADR 0003](decisions/0003-opus-fallback.md). Not fixed upstream by
this project.

**Cost:** `opusscript` uses measurably more CPU per stream than the native encoder. At the target
scale (≤ 5 guilds, one stream each) this has not been a problem, but it has not been benchmarked
under concurrent load either — see KI-4.

### KI-2 — About a third of the archive cannot be played (Minor, upstream data)

Measured over a 100-record page: **33 records have an empty `path`** and **34 have an empty
`length`**.

**Reproduce:** `npm run probe` prints both counts.

**Behaviour:** unplayable records are dropped before scoring, so `play` and `search` never offer
one. The consequence is honest but visible — a search for a track that exists in the archive's
*index* but has no file returns no result, which can look like a search bug and is not. There is no
fix available from this side.

### KI-5 — Some tracks display under the archive's abbreviated title (Minor, cosmetic)

`all girls are the same` resolves to the correct released recording but displays as
**"AGATS (Pt. 1)"**, because the canonical title comes from `track_titles[0]` and that is what the
archive puts first.

**Reproduce:** `jw!song all girls are the same`.

**Not fixed, deliberately:** the 999 Vault desktop client picks the title the same way. Diverging
would mean the same query shows two different names in the two apps, which is a worse defect than an
abbreviation. The full name appears on the alias line of the `song` embed.

### KI-6 — An exact alias outranks a prefix match on a different track (Minor, by design)

`misery` resolves to **"Sad Thing"**, which carries an exact archive alias `Misery` (950), beating a
prefix match on `Misery Avenue` (700).

**Reproduce:** `jw!song misery`.

**Behaviour:** defensible — the archive asserts the alias — but a user may have meant the other
track. Both appear together under `jw!search misery`. No change planned; changing the rule ordering
to fix this would break more common cases than it fixes.

### KI-7 — Era and album names are not searchable (Minor, scope)

`outsiders` returns no match: it is an era/album name and no track is titled that. The reply names
the term, suggests trying an alternate title, and states the archive size rather than a bare
not-found. Era browsing is out of scope.

### KI-3 — `image_url` is often a shared placeholder (Minor, cosmetic)

Many records return `/assets/999.jpg` rather than per-track art, so several different songs show an
identical thumbnail.

**Behaviour:** the path is resolved against the site origin so the image renders rather than
breaking. No per-track fallback to the cover-art endpoint is attempted for metadata embeds, because
the cover-art endpoint is keyed by archive `path` and returns bytes, not a URL Discord can fetch.

---

## Unverified — no Discord credentials were available in this build

Everything below is specified, implemented, and unit-tested offline, but has **not** been observed
against a live gateway, because this build had no bot token, no test guild, and no voice channel.
None of it should be reported as working until `npm run verify:voice` has been run and its report
committed to `evidence/`.

- **KI-U1 — Voice smoke test not executed.** `npm run verify:voice` requires `DISCORD_TOKEN`,
  `TEST_GUILD_ID`, and `TEST_VOICE_CHANNEL_ID`. No `evidence/voice-smoke-*.json` exists yet. The
  timing claims in the brief — first audio under 4 s, zero `Buffering` re-entries over 30 s,
  `playbackDuration` ≥ 29000 ms — are **unmeasured**.
- **KI-U2 — Multi-guild isolation matrix not executed.** Isolation is structural (see
  [architecture](architecture.md#2-guildplayer-is-the-single-state-authority)) and covered by
  offline tests against fake players, but two real concurrent guilds have not been observed.
- **KI-U3 — No embed screenshots.** Light-theme and dark-theme contrast has not been reviewed in a
  real Discord client. Embed field content is asserted in unit tests; appearance is not.
- **KI-U4 — 60-minute mixed session not run.** No statement can be made about long-session memory
  behaviour, unhandled rejections over time, or embed/audio state divergence.
- **KI-U5 — Radio relay not heard.** `/radio/live/` parsing, the `http:`→`https:` upgrade, poller
  lifecycle, and clock extrapolation are unit-tested against captured responses. Audible station
  playback in a voice channel has not been confirmed.

### KI-4 — No performance measurements (Major for the definition of done)

`docs/performance.md` requires command-to-first-audio p50/p95 over 10 invocations, search round-trip
p95, and RSS after 30 minutes with 3 active players. All of these need a live gateway. The document
records the measurement procedure and the machine specification, with the numbers marked as not yet
taken.

---

## Closed

### KI-8 — The archive retry policy never ran (Critical, fixed)

`ApiError` stored `status` under `error.details`, but the retry predicate in `api/client.js` tested
`error.status`. Every 5xx, 429 and timeout therefore failed on the **first** attempt — the four-attempt
budget, the exponential backoff and the `Retry-After` handling were all unreachable.

**Reproduce (before the fix):** point `ArchiveApi` at a handler returning `503` and count requests —
1, not 4.

**Fixed** by hoisting error details onto the instance, matching the desktop client's
`Object.assign(this, details)` that the retry semantics were ported from. Covered by four
request-counting tests in `test/resilience.test.mjs`. Full write-up in
[reviews/milestone-6.md](reviews/milestone-6.md).

### KI-9 — A late FFmpeg failure skipped a second track (Critical, fixed)

A source that reported failure *after* the user had skipped or seeked past it advanced the queue
again, silently consuming a track that never played.

**Reproduce (before the fix):** queue three tracks, skip to the second, then fire the first source's
error callback — the player jumps to the third.

**Fixed** with a monotonic source token; a stale source's error is ignored. See D-6 in
[reviews/milestone-3-5.md](reviews/milestone-3-5.md).

### KI-10 — The requester mention rendered as raw markup (Major, fixed)

`queuedEmbed` put the requester in the embed footer, where Discord does not render mentions, so every
`play` reply showed a literal `<@…>`.

**Fixed** by moving it to the description. Worth noting how it was found: by reading the code against
Discord's rendering rules, because the embed critic — the pass that would have caught it in one
glance at a screenshot — could not run. Other defects of this class may remain.

### KI-11 — `radio stop` restarted the interrupted track (Minor, fixed)

Resuming the suspended queue rebuilt the track's source with no seek offset, so a listener three
minutes into a song heard it from the top.

**Fixed** by stamping the elapsed position when the queue is suspended and using it as the resume
offset.

### KI-0 — `node --test test/` fails on Node 26 (Fixed)

Passing a bare directory to `--test` was resolved as a module specifier and failed with
`MODULE_NOT_FOUND` on Node 26.3.1. Fixed in `scripts/verify.mjs` by using the glob form
`test/**/*.test.mjs`, which also keeps `test/helpers/` (fixtures, not tests) out of the run.
