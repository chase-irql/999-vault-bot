# Performance

## Machine

| | |
|---|---|
| CPU | Intel Core i7-14700KF |
| RAM | 64 GB |
| OS | Windows 11 Pro 10.0.19045 |
| Node | v26.3.1 |
| Opus | `opusscript` (pure JS) — `@discordjs/opus` has no prebuild for this ABI, see [ADR 0003](decisions/0003-opus-fallback.md) |
| FFmpeg | `ffmpeg-static` 5.3.0, resolved to `node_modules/ffmpeg-static/ffmpeg.exe` |
| Network | Domestic broadband, archive reached over the public internet |

Numbers below are from this machine. A deployment on a small Linux VPS will differ, most obviously
in the Opus encoding cost.

---

## Measured

### Archive search round-trip

12 distinct queries, cold cache, one archive request each.

| Metric | Value |
|---|---|
| p50 | **176 ms** |
| p95 | **292 ms** |
| min / max | 161 ms / 292 ms |

The same 12 queries repeated inside the 5-minute TTL: **p95 = 1 ms**, zero HTTP requests. The first
query in a cold process is the slowest (292 ms) because it includes TLS setup.

### Scoring cost

Ranking the full 145-record fixture corpus, 2,000 iterations:

| Metric | Value |
|---|---|
| Per query | **0.372 ms** |

Scoring is not a meaningful share of any user-visible latency; the round-trip dominates by roughly
500×. This is why the resolver fetches exactly one page and ranks client-side rather than trying to
push ranking into the API — there is no ordering parameter, and there would be no point.

### Memory

| State | RSS |
|---|---|
| Baseline (module graph loaded, no players) | **78 MB** |
| 3 guild players constructed | **79 MB** |
| After `destroyAll` | **78 MB** |

A guild player costs on the order of a megabyte before audio flows. Teardown returns to baseline
exactly, so the registry is not retaining destroyed players.

**Caveat:** these players were constructed but never streamed — no FFmpeg process, no live
connection. It demonstrates that the registry and player objects do not leak; it says nothing about
memory during sustained playback. See below.

---

## Not measured — no Discord credentials were available

The following require a bot token, a test guild, and a voice channel. This build had none, so the
numbers are **not taken**. They are not estimated, and they must not be quoted as if they were
measured.

| Metric | Required by | Status |
|---|---|---|
| Command-to-first-audio p50 / p95 over 10 `play` invocations | Experience pillar 2 (< 4 s) | **not taken** |
| `Playing` reached within 4 s of resource creation | Milestone 3 exit gate | **not taken** |
| Zero `Buffering` re-entries over 30 s | Milestone 3 exit gate | **not taken** |
| `playbackDuration` advance ≥ 29,000 ms in 30 s | Voice smoke test | **not taken** |
| Gap between tracks (< 1.5 s) | Milestone 4 exit gate | **not taken** |
| RSS after 30 minutes with 3 active players | Definition of done | **not taken** |
| RSS after teardown within 20 MB of pre-playback baseline | Definition of done | **partially** — proven for players without audio (78 → 78 MB); not proven under load |
| Opus encoding CPU cost under `opusscript` | ADR 0003 risk | **not taken** |

### How to take them

`scripts/verify-voice.mjs` measures every timing item above and writes a JSON report to
`evidence/`. It asserts rather than merely records, and exits non-zero on any failure.

```bash
npm run verify:voice
```

```bash
npm run verify:voice -- --radio
```

```bash
npm run verify:voice -- --guilds 2
```

Requires `DISCORD_TOKEN`, `TEST_GUILD_ID`, and `TEST_VOICE_CHANNEL_ID` in `.env`; the matrix also
needs `TEST_GUILD_ID_2` and `TEST_VOICE_CHANNEL_ID_2`.

For the 30-minute RSS figure, start the bot with three guilds playing and sample
`process.memoryUsage().rss` — the `ping` command reports it, so `jw!ping` at the start and after
thirty minutes is enough, with `jw!stats` confirming the active player count.

### What can be said about first-audio latency without measuring it

Only the components, and only as components:

- Archive resolution is a measured **176 ms p50 / 292 ms p95** cold, **~1 ms** warm.
- FFmpeg starts with `-analyzeduration 0` and reads a Range-capable HTTPS source, so it does not
  read the whole file before emitting samples.
- The voice handshake and Opus encoder startup are unmeasured here.

That is not a latency budget and does not establish the under-4-second target. It is the part of the
path that has been measured, stated as such.
