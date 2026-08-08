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

### KI-0 — `node --test test/` fails on Node 26 (Fixed)

Passing a bare directory to `--test` was resolved as a module specifier and failed with
`MODULE_NOT_FOUND` on Node 26.3.1. Fixed in `scripts/verify.mjs` by using the glob form
`test/**/*.test.mjs`, which also keeps `test/helpers/` (fixtures, not tests) out of the run.
