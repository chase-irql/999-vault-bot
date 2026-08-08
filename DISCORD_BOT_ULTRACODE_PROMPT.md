# Ultracode Prompt — 999 Vault Discord music bot

Build a complete, self-hosted Discord music bot that streams any song in the JuiceWRLDAPI archive into a Discord voice channel and relays the live 999 FM station, driven by `jw!` prefix commands. This is not a demo, prototype, snippet collection, or "here is how you would wire it up" sketch. Deliver a runnable Node.js service with a real command surface, a real per-guild playback state machine, real error and reconnect behavior, automated tests, captured evidence of audio actually playing, and a repository that a fresh clone can start from documented commands.

## Product target

The audience is a small private Discord server (single digit guilds, under 50 concurrent listeners) run by the owner of the 999 Vault desktop client. Members already know the archive. They want to type `jw!play lucid dreams` in a text channel, have the bot join their voice channel within seconds, and hear the correct track. They want a queue they can inspect and reorder, and they want `jw!radio` to drop the live 999 FM station into voice without any queue interaction.

"Finished" means: a maintainer clones the repo on a clean Windows or Linux machine, runs the documented install and start commands, supplies a bot token, invites the bot, and every command in `CLAUDE.md` works against the live archive with correct audio, correct embeds, and no unhandled rejections in the logs across a 60-minute session that includes queue churn, skips, seeks, voice-channel moves, network interruption, and a radio switchover.

## Non-negotiable constraints

### Stack and runtime

- Node.js. Require `>=22.0.0` in `engines`; record the actual installed version (`node -v`) in the README. ES modules only (`"type": "module"`). No TypeScript, no build step, no bundler — the entrypoint runs directly.
- `discord.js` pinned to `14.27.0`. Do **not** use the `dev` dist-tag or any `15.0.0-dev.*` build; v15 is unreleased and unstable.
- `@discordjs/voice` pinned to `0.19.2`.
- `prism-media` pinned to `1.3.5`.
- Voice encryption: `@noble/ciphers` pinned to `2.2.0` (pure JS, no native toolchain). Do not add `sodium-native`, `libsodium-wrappers`, or `tweetnacl` unless `@noble/ciphers` demonstrably fails a real voice connection; if it does, record the failure in an ADR before substituting.
- Opus encoding: `@discordjs/opus` pinned to `0.10.0`, with a documented fallback to `opusscript` if the native prebuild is unavailable on the target machine. The README must state which one is in use and how to check.
- FFmpeg: `ffmpeg` is **not on PATH on the development machine** (verified). Depend on `ffmpeg-static` pinned to `5.3.0` and resolve the binary path explicitly rather than assuming PATH. Provide an env override `FFMPEG_PATH` for hosts that ship a system FFmpeg. Log the resolved FFmpeg path and version at startup.
- Every dependency pinned to an exact version in `package.json` (no `^`, no `~`). Commit `package-lock.json`. `npm ci` must be the documented install path.
- Total production dependency count must stay at or below 8 direct packages. Justify each in the README. Do not add a logging framework, a validation framework, an ORM, a web framework, or a scheduler — write the small amount of code those would replace.

### Platform and operations

- Must run on Windows 11 (development) and Linux x64 (deployment) from the same commands. Use `node:path` and never hand-concatenate paths.
- Start commands: `npm ci`, then `npm start`. Development: `npm run dev` (Node's built-in `--watch`). Verification: `npm run verify`.
- Configuration exclusively through environment variables loaded from `.env` via Node's built-in `--env-file` flag. No `dotenv` dependency. `.env` is gitignored; `.env.example` is committed with every key and a safe placeholder.
- The bot process must exit non-zero with a single readable error line if required configuration is missing or malformed. It must never start half-configured.
- Graceful shutdown on `SIGINT`/`SIGTERM`: destroy all voice connections, flush logs, exit 0 within 5 seconds.

### Archive API — verified contract, do not invent endpoints

Base URL `https://juicewrldapi.com/juicewrld`, overridable via `API_BASE_URL`. These endpoints and shapes were verified live; treat them as the contract and re-verify anything not listed here before using it.

- `GET /health/` → `{ "status": "ok" }`.
- `GET /songs/` → Django-REST paginated `{ count, next, previous, results: [...] }`. Query parameters that are known to work: `searchall`, `page`, `page_size`, `category`, `era` (era **name**, not id), `file_names_array=true`. There is **no** ordering parameter — sort client-side.
- `GET /songs/{id}/` → single song record.
- Song record fields include: `id`, `public_id`, `name`, `original_key`, `category`, `era: { id, name, description, time_frame, play_count }`, `path`, `track_titles: []`, `credited_artists`, `producers`, `engineers`, `length` (a `"m:ss"` string, not seconds), `album`, `image_url`, `date_leaked`, `leak_type`, `lyrics`, `synced_lyrics`.
- `category` is one of `released`, `unreleased`, `unsurfaced`, `recording_session`.
- `GET /stats/` → `{ total_songs, category_stats, era_stats }`. Live value at time of writing: 2525 songs.
- `GET /eras/`, `GET /categories/`, `GET /playable_songs/`.
- `GET /files/download/?path=<url-encoded path>` → `audio/mpeg`, **supports HTTP Range** (verified `206` with `Accept-Ranges: bytes` and a `Content-Range`). This is the per-song audio source.
- `GET /files/cover-art/?path=` and `GET /files/image-thumbnail/?path=&size=` → raw image bytes.
- `GET /radio/live/` → station status. Verified shape:
  `{ station, state, dj_enabled, dj_line, now_playing: { title, artist, album, display, elapsed_ms, duration_ms }, up_next: {...}, queue_preview: [string], vote: { active }, discord_listeners, is_live, stream_url, stale_seconds, web_listeners, total_listeners, eligible_web_voters, eligible_voters }`.
- `GET /radio/stream.mp3` → continuous `audio/mpeg`. **No** `Content-Length`, **no** `Accept-Ranges`. It is not seekable and never ends. Do not treat it like a file.
- `GET /radio/random/` → `{ id, title, path, size, modified, hash, song: {...} }`.
- `POST /plays/` and `GET /plays/stats/` exist. Do not post play events from the bot unless you first confirm the payload contract against a live request; an unverified write is forbidden.

Critical detail: `/radio/live/` returns `stream_url` as **`http://`**. Upgrade it to `https://` before use, exactly as the desktop client does. Never fetch archive audio over cleartext.

Reference implementation for the API client is `C:\Users\user\Documents\jw-song-downloader\api-client.js` in the desktop repo — read it for the retry, timeout, and abort semantics, and port those semantics rather than reinventing them. Treat that repository as read-only.

### Discord constraints and the privileged-intent conflict

The requested `jw!` prefix requires the **Message Content** privileged intent. This is a real constraint with real consequences, and both sides of it must ship:

1. Prefix commands over `GatewayIntentBits.MessageContent` are the **primary** surface. `jw!` is the default prefix, overridable per-deployment via `COMMAND_PREFIX`. Prefix matching is case-insensitive; `JW!play` works.
2. Because Message Content is privileged — it must be enabled manually in the Discord Developer Portal, and an unverified bot is capped at 100 guilds — **also** register slash-command equivalents for every command. Slash commands are not optional polish; they are the surface that keeps the bot functional if the intent is off or revoked.
3. Both surfaces must route into the identical command implementation. A command is defined once. If prefix and slash behavior can diverge, the architecture is wrong.
4. Detect at startup whether Message Content is actually granted. If it is not, log a single clear warning naming the portal toggle, and continue running in slash-only mode rather than silently ignoring every message.

Required gateway intents: `Guilds`, `GuildVoiceStates`, `GuildMessages`, `MessageContent`. Do not request `GuildMembers` or `GuildPresences` — nothing in scope needs them.

### Secrets, scope, and repository hygiene

- The bot token is never logged, never included in an error message, never committed, and never echoed by a command. Redact any string matching the Discord token pattern in the logger before output.
- `npm run precommit` runs a secret scan (`scripts/check-secrets.mjs`) over staged content for the token pattern `[MNO][A-Za-z\d_-]{23,}\.[\w-]{6}\.[\w-]{27,}` and for any staged `.env`. It must exit non-zero on a hit. Run it before every commit.
- The bot is for private guilds. Gate it behind `GUILD_ALLOWLIST` (comma-separated guild IDs). If the allowlist is non-empty, leave any guild not on it immediately after joining and log the event. Do not enable the public bot listing, do not implement a vanity invite page, and do not add analytics that phone home.
- Preserve the desktop project's posture in the README: 999 Vault is an independent project, not affiliated with, endorsed by, or operated by the JuiceWRLDAPI team, and it credits JuiceWRLDAPI.com as the archive source.

### Repository and commit policy

- Create the repository at `C:\GitHub\999-vault-bot`. Initialize Git on `main`.
- Create the GitHub remote as **private**: `gh repo create choz-dev/999-vault-bot --private --source=. --remote=origin --push`. The `gh` CLI is installed and authenticated as `choz-dev` with `repo` and `workflow` scopes. If the repository must instead be public, stop and ask before creating it — do not decide that unilaterally.
- After **every** logical change: run `npm run verify`, run `npm run precommit`, commit with a Conventional Commits message, and `git push origin main`. One logical change per commit. Never `--force`, never `--no-verify`, never commit `node_modules/`, `.env`, audio files, or captured evidence binaries larger than 2 MB.
- If `npm run verify` fails, fix it before committing. Do not commit a red tree and follow up with a fix commit.

## Experience pillars

These four rules decide every design argument. When a feature does not serve one of them, cut it.

1. **`jw!play <song_name>` must land on the right track.** The archive has 2500+ entries with alternate titles, versions, and leaked variants. Resolution quality is the product. A bot that plays the wrong "Bad Day" is a failed bot.
2. **Audio starts fast and never stutters.** From command to first audible sample: under 4 seconds on a normal connection. Zero buffering-state re-entries during steady-state playback.
3. **The bot never lies about its state.** The now-playing embed, the queue embed, and the actual audio stream are always consistent. If playback failed, the message says so with a reason, not a generic red X.
4. **It recovers instead of dying.** Voice disconnects, archive 5xx, moved channels, empty channels, and killed streams all have defined behavior. An unhandled rejection that takes the process down is a critical defect.

## Scope boundary

**In scope:** song search and resolution, per-guild queue, voice playback of archive audio, seek, volume, loop, shuffle, now-playing and queue embeds, song metadata lookup, 999 FM live radio relay, station status embed, error and reconnect handling, allowlist gating, structured logs, tests, CI, documentation.

**Explicitly excluded — mark these as excluded in the README, do not silently omit them:**

- **Lyrics output.** The API returns `lyrics` and `synced_lyrics`. The bot must never post lyric text to Discord. Metadata embeds only. This is a deliberate copyright decision, not an oversight.
- **Downloads, zip jobs, and file sharing.** `/files/zip-*`, `/start-zip-job/`, `/files/share/` are out of scope.
- **The 999 Vault account service.** No Discord OAuth login, no synced likes, no cloud playlists, no listening-event upload. The bot is stateless across restarts except for its config.
- **Persistent per-guild settings.** No database. Volume, loop mode, and queue are in-memory and reset on restart. Document this.
- **Radio voting.** `/radio/live/` exposes a `vote` object; do not build a voting command against an unverified write contract.

**Deferred (optional, only after Milestone 6 passes):** slash-command autocomplete on song names, a `jw!wrapped`-style stats command, Docker packaging.

**Scale target:** up to 5 guilds, one voice connection per guild, one shared archive API client with global rate limiting.

## Shared architecture

Establish this before writing any command. Write it into `docs/architecture.md` and an ADR log at `docs/decisions/` before broad implementation.

```
src/
  index.js              composition root: config -> logger -> api -> registry -> client -> login
  config.js             env parsing, validation, typed config object, redaction list
  core/logger.js        JSON-line logger with levels + token redaction (hand-written)
  core/errors.js        AppError taxonomy: ConfigError, ApiError, ResolveError, VoiceError, UserError
  core/result.js        small ok/err helper used at module boundaries
  api/client.js         ArchiveApi: fetch + timeout + retry + abort (ported semantics)
  api/normalize.js      raw song record -> canonical Song (pure)
  api/search.js         scoring + ranking + disambiguation (pure, no I/O)
  api/cache.js          bounded TTL LRU for search results, eras, song records
  audio/registry.js     Map<guildId, GuildPlayer>; create/get/destroy; the only place players are made
  audio/guild-player.js per-guild state machine: connection, queue, current, loop, volume
  audio/source.js       Song -> AudioResource via FFmpeg (seek support, range/URL input)
  audio/radio.js        RadioStation: /radio/live/ poller + stream resource construction
  core/queue.js         pure queue reducer: enqueue/dequeue/remove/move/clear/shuffle/jump
  bot/client.js         discord.js Client construction, intents, event wiring, lifecycle
  bot/router.js         pure: (content, prefix) -> { name, args, rest } | null
  bot/context.js        CommandContext: normalized shape produced from BOTH message and interaction
  bot/commands/index.js command registry: name, aliases, description, usage, execute(ctx)
  bot/commands/*.js     one file per command
  bot/embeds.js         pure embed builders; no command builds an embed inline
scripts/
  verify.mjs            orchestrates lint + tests; the single verification entrypoint
  verify-voice.mjs      real gateway + real voice connection smoke test
  check-secrets.mjs     staged-content secret scan
  probe-api.mjs         hits every used endpoint, prints shape summary, exits non-zero on drift
test/
  *.test.mjs            node:test, no test framework dependency
```

**State authority.** `GuildPlayer` is the single authority for a guild's voice connection, queue, current track, loop mode, and volume. Commands do not mutate queues, do not touch `VoiceConnection`, and do not construct `AudioResource`. They call intent methods on the player (`player.enqueue(song)`, `player.skip()`, `player.seek(seconds)`) and render the returned state. `audio/registry.js` is the only module that constructs or destroys a `GuildPlayer`.

**The CommandContext boundary is the key architectural decision.** Every command receives a `CommandContext` — `{ guildId, channelId, userId, memberVoiceChannelId, args, rest, reply(payload), editReply(payload), defer() }` — built identically from a `messageCreate` event or a `ChatInputCommandInteraction`. Commands import nothing from `discord.js` except types. This is what makes 90% of behavior testable without a gateway connection: tests construct a fake `CommandContext`, run the command against a mocked `ArchiveApi` and a fake player, and assert on the captured reply payload.

**Data flow.** `Discord event -> router/interaction -> CommandContext -> command -> (ArchiveApi | GuildPlayer) -> state -> embeds -> ctx.reply`. One direction. Nothing flows backward.

**Forbidden coupling — enforce with a test that greps imports:**

- `bot/commands/*` may not import `@discordjs/voice`, `node:fetch`/`undici`, or `audio/source.js`.
- `api/*` may not import anything from `bot/` or `audio/`.
- `core/queue.js`, `api/search.js`, `api/normalize.js`, and `bot/embeds.js` must be pure: no imports of `discord.js`, no I/O, no timers, no randomness that is not injected.
- Only `core/logger.js` may call `console.*`.

**Canonical Song shape** produced by `api/normalize.js` and consumed everywhere downstream:

```js
{
  id: 94034,
  publicId: 2402,
  title: "lucid dreams (forget me)",
  aliases: ["Lucid Dreams", "Lucid Dreams (Pt. 1)", "Remember Me"],
  path: "Compilation/1. Released Discography/4. JuiceWRLD 9 9 9/lucid dreams (forget me).mp3",
  artist: "Juice WRLD",
  album: "Goodbye & Good Riddance",
  durationSeconds: 239,        // parsed from the "3:59" string; null if unparseable
  category: "released",
  era: { id: 105, name: "jw 999", timeFrame: "(May 2017-May 2018)" },
  imageUrl: "https://...",
  streamUrl: "https://juicewrldapi.com/juicewrld/files/download/?path=..."
}
```

`length` is a `"m:ss"` string and is sometimes empty or malformed. Parse defensively; `durationSeconds: null` must render as `--:--`, never `NaN:NaN`.

## Song resolution — the primary system

`jw!play <song_name>` takes free-form text and must produce exactly one track or an honest disambiguation.

**Pipeline:**

1. If the argument is a bare integer that matches a song `id` or `public_id`, resolve directly via `/songs/{id}/`.
2. If the argument is a full archive path (contains `/` and ends in an audio extension), use it directly.
3. Otherwise query `GET /songs/?searchall=<query>&page_size=25&file_names_array=true`.
4. Score each result in `api/search.js` — a **pure function** over the canonical Song list, fully unit-tested:
   - Normalize both sides: lowercase, strip punctuation, collapse whitespace, strip leading articles.
   - Exact match on `title` → 1000. Exact match on any alias → 950. Exact on `file_names` entry → 900.
   - Prefix match on title → 700; on alias → 650.
   - All query tokens present in title → 500; in alias → 450; in `album` → 300.
   - Substring anywhere → 200.
   - Tie-breakers, in order: `category` preference (`released` > `unreleased` > `recording_session` > `unsurfaced`), then higher `era.play_count`, then shorter title, then lower `id` for determinism.
   - Results with no `path`, or a `path` whose extension is not `.mp3`/`.wav`/`.m4a`/`.flac`, are dropped before scoring.
5. If the top score is ≥ 900, or exceeds the runner-up by ≥ 200, play it directly.
6. Otherwise reply with a numbered disambiguation embed of the top 5 (title, era, category, duration). Accept resolution for 60 seconds by either a bare `1`–`5` message from the invoking user in the same channel, or `jw!play 3`. Expire silently after 60s and clean up the pending state — do not leak listeners.
7. Zero results: reply with the searched term, a suggestion to try an alternate title, and the archive song count. Never reply with a bare "not found".

**Acceptance criteria, tested against real fixtures captured from the live API:** `lucid dreams` resolves to `lucid dreams (forget me)`. `armed and dangerous` resolves to the released version, not a session variant. `999` does not crash or hang on a broad match. A query with 200 results does not fetch 200 pages. Queries are cached for 5 minutes; the same query twice inside that window issues exactly one HTTP request (assert on a request counter).

## Playback and queue

**Commands (all prefixed `jw!`, all with slash equivalents):**

| Command | Aliases | Behavior |
|---|---|---|
| `jw!play <query>` | `p` | Resolve, join the invoker's voice channel, enqueue. If nothing is playing, start. If playing, append and report queue position. |
| `jw!playnext <query>` | `pn` | Same, but insert at position 1. |
| `jw!pause` / `jw!resume` | | Toggle the audio player. Idempotent — pausing a paused player replies "already paused", not an error. |
| `jw!skip` | `s`, `next` | Advance. Respects loop mode: `track` loop is cleared for this advance only. |
| `jw!stop` | | Clear the queue, stop, leave the channel. |
| `jw!queue [page]` | `q` | Paginated embed, 10 per page, showing position, title, duration, requester. |
| `jw!nowplaying` | `np` | Current track embed with a live progress bar, elapsed/total, source, requester. |
| `jw!remove <n>` | `rm` | Remove queue position n. |
| `jw!move <from> <to>` | `mv` | Reorder. |
| `jw!clear` | | Empty the queue but keep playing the current track. |
| `jw!shuffle` | | Fisher–Yates with an injected RNG so it is testable. |
| `jw!loop [off\|track\|queue]` | `repeat` | No argument cycles modes. |
| `jw!seek <mm:ss\|seconds>` | | Restart the FFmpeg source with `-ss`. Rejected for radio. |
| `jw!volume [0-200]` | `vol` | Per-guild, applied via `inlineVolume`. No argument reports current. |
| `jw!join` / `jw!leave` | | Explicit connection control. |
| `jw!song <query>` | `info` | Metadata embed with no playback: title, aliases, era, category, producers, engineers, recording location, duration, cover art. **No lyrics.** |
| `jw!search <query>` | `find` | Top 10 scored results as a numbered list, with the exact `jw!play` invocation for each. |
| `jw!radio [stop\|status]` | `fm`, `999` | See the radio section. |
| `jw!stats` | | Archive stats from `/stats/` plus bot uptime, guild count, active players. |
| `jw!help [command]` | `h`, `commands` | Generated from the command registry — never a hand-maintained string. |
| `jw!ping` | | Gateway heartbeat, archive `/health/` latency, memory RSS. |

**Audio sourcing.** Build the `AudioResource` in `audio/source.js` by invoking FFmpeg via `prism-media` with the HTTPS `streamUrl` as input. Do not download the whole file, do not buffer it in memory, do not write temp files. Required FFmpeg arguments: `-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5` before `-i`, `-analyzeduration 0 -loglevel 0`, output `-f s16le -ar 48000 -ac 2`. For seek, place `-ss <seconds>` **before** `-i` for fast input seeking. Create the resource with `inputType: StreamType.Raw` and `inlineVolume: true`.

**Player state machine.** `GuildPlayer` wraps one `AudioPlayer` created with `NoSubscriberBehavior.Pause`. Explicit transitions: `idle -> loading -> playing -> (paused) -> playing -> idle`. On `AudioPlayerStatus.Idle` following `Playing`, advance the queue honoring loop mode. On `AudioPlayerStatus.Buffering` re-entry during steady state, log a warning with the track path — that is a defect signal, not normal operation.

**Failure behavior — each of these has a defined, tested outcome:**

- Invoker not in a voice channel → `UserError`, no join attempt.
- Bot lacks `Connect` or `Speak` in the target channel → name the missing permission and the channel.
- Voice channel is full or the bot is region-blocked → surface the Discord error message, do not retry forever.
- Archive returns 5xx or times out → retry per the ported client policy (4 attempts, exponential backoff honoring `Retry-After`), then skip to the next queue item and post one message naming the failed track.
- FFmpeg exits non-zero → log stderr at debug, skip the track, report it once.
- `VoiceConnectionStatus.Disconnected` → attempt `entersState(Signalling|Connecting, 5000)`; on success continue; on failure destroy the connection and clear the guild's player.
- Bot alone in the channel for `IDLE_DISCONNECT_MS` (default 300000) → leave, clear queue, log.
- Bot dragged to a different voice channel → follow it and keep playing, do not stop.
- Two `jw!play` commands racing in one guild → serialize through a per-guild async lock. No duplicated joins, no interleaved resources.

## 999 FM radio

`jw!radio` relays the live station into voice. It is a distinct playback source, not a queue item, and the design must reflect that.

- On `jw!radio`, join the invoker's channel and stream the upgraded-to-HTTPS `stream_url` from `/radio/live/`, falling back to `${API_BASE_URL}/radio/stream.mp3` if the field is absent.
- Entering radio mode clears the current track and **suspends** the queue — it does not destroy it. `jw!radio stop` returns to the queue at the position it was left. State this behavior in `jw!help`.
- The stream is infinite and unseekable. `jw!seek`, `jw!loop`, `jw!skip`, `jw!queue` operations against radio mode reply with a clear explanation rather than silently no-oping. `jw!pause`, `jw!volume`, and `jw!stop` remain valid.
- Poll `/radio/live/` every 15 seconds while any guild is in radio mode — one shared poller for the whole process, never one per guild. Stop polling when no guild is listening.
- The now-playing embed in radio mode shows `station`, `now_playing.display`, `album`, a progress bar computed from `elapsed_ms`/`duration_ms` **advanced locally between polls** (the station only reports every 15s — the desktop client stamps the sample time and extrapolates; do the same), `up_next.display`, the first five `queue_preview` entries, `dj_line`, and `total_listeners`.
- When `now_playing.title` changes, edit the pinned status message in place if one exists. Do not spam a new message per track.
- `stale_seconds` above 60, or `is_live: false`, or `state !== "playing"` → show a degraded "station may be offline" state rather than a confidently wrong now-playing.
- The station stream can drop. On FFmpeg exit or stream end while in radio mode, reconnect with exponential backoff (2s, 4s, 8s, capped at 30s, max 5 attempts) and post one message if all attempts fail.
- `/radio/live/` exposes `discord_listeners`. Do not attempt to increment it — no write contract for it has been verified. If `GET /` (the overview endpoint) documents a listener-registration route, you may use it; otherwise leave the field alone and note it as unused in the README.

## Presentation

Embeds are the entire UI. They are built only in `bot/embeds.js`, as pure functions returning plain objects, and are unit-tested on field content.

- **Accent colors:** playback `0x8B5CF6` (violet), radio `0xE11D48` (rose), error `0xEF4444`, info `0x64748B`, success `0x22C55E`. One constant table, no inline hex anywhere else.
- **Now playing:** title as the embed title linked to nothing (no clickable stream URL — it exposes the archive path), author line `Now playing`, thumbnail from `imageUrl` or the cover-art endpoint, a 20-character progress bar using `━` with `⬤` at the position, `elapsed / total`, and fields for era, category, and requester.
- **Queue:** description list, monospace-aligned positions, total queue duration in the footer, `Page n of m`.
- **Errors:** one-line title stating what failed, one-line description stating what the user can do. Never dump a stack trace, never surface a raw URL containing archive paths, never print the token.
- **Truncation:** every user-supplied or archive-supplied string is clamped to Discord's limits (title 256, description 4096, field value 1024, 25 fields, 10 embeds) before send. A 4097-character description must never cause a 400. Test this with a deliberately oversized fixture.
- **Sanitization:** escape Discord markdown in archive-sourced titles — the archive contains `*`, `_`, and backticks. A title must not break embed formatting.
- **Failure modes that mean this is unfinished:** default blurple embeds with no accent, raw JSON dumped into a code block, `undefined` or `NaN` rendered in any field, progress bars that exceed 100%, embeds that show a duration for the radio stream, timestamps in raw epoch milliseconds.

## How to work

1. **Inspect first.** Read `C:\Users\user\Documents\jw-song-downloader\api-client.js`, `electron\catalog.js`, and the radio handling in `electron\renderer\app.js` before writing the API layer. Port the semantics; do not copy files wholesale into the new repo.
2. **Architecture before features.** Commit `docs/architecture.md`, the module skeleton, and `docs/decisions/0001-stack.md` as the first substantive commit, before any command exists.
3. **Run `scripts/probe-api.mjs` before implementing against any endpoint.** The contract above was verified on a specific date. If the live shape has drifted, update the prompt's assumptions in an ADR rather than coding against a stale contract.
4. **Small increments.** Every command is its own commit. Every commit passes `npm run verify` and gets pushed.
5. **Do not replace working code without evidence.** If a refactor is warranted, state the defect it fixes in the commit body.
6. **Record defects honestly** in `docs/known-issues.md` as you find them, including ones you did not fix. An empty known-issues file at the end of a project this size is not credible.

Work as sequential passes with explicit role hats, and state which hat you are wearing in each commit body: **API owner** (client, normalize, search, cache), **Audio owner** (registry, guild-player, source, radio), **Command owner** (router, context, commands, embeds), **Integration owner** (composition root, lifecycle, CI, evidence, merges). The Integration owner runs last on every milestone and is responsible for the milestone actually working end to end — not for the individual modules compiling.

## Verification harness

`npm run verify` runs, in order, and fails on the first failure:

1. `node --check` over every source file (syntax gate, zero dependencies).
2. `node --test test/` — Node's built-in runner. **No Jest, Mocha, Vitest, or Chai.**
3. The import-boundary test that enforces the forbidden-coupling rules by parsing import statements.
4. A dependency-pin test asserting no `^` or `~` in `package.json` dependencies.

**Required unit coverage (all pure, all offline):**

- `api/search.js` scoring against at least 20 real song fixtures captured from the live API into `test/fixtures/songs.json`, including the ambiguous cases named above.
- `api/normalize.js` duration parsing: `"3:59"`, `"12:04"`, `""`, `null`, `"unknown"`, `"1:02:33"`.
- `core/queue.js` reducer: every operation, plus out-of-range indices, empty queue, single-item queue, and loop-mode interaction with skip.
- `bot/router.js` parsing: correct prefix, wrong prefix, case variations, extra whitespace, quoted arguments, empty command, prefix-only message, a message from a bot user.
- `bot/embeds.js`: oversized inputs clamped, markdown escaped, null duration rendered as `--:--`, progress bar bounded to [0, 100].
- Every command executed against a fake `CommandContext` + mocked `ArchiveApi` + fake player, asserting the reply payload — including the not-in-voice, no-results, and disambiguation-timeout paths.

**Integration tests** run the real `ArchiveApi` against the live archive, tagged so they can be skipped offline (`SKIP_LIVE=1`). They assert the verified contract above still holds: `/health/` returns ok, `/songs/?searchall=lucid` returns a paginated envelope, `/files/download/` honors a Range request with a 206, `/radio/live/` contains `now_playing.elapsed_ms`.

**Voice smoke test** — `npm run verify:voice`, driven by `scripts/verify-voice.mjs`, requires `TEST_GUILD_ID` and `TEST_VOICE_CHANNEL_ID`. It logs in, joins, plays a known track, and asserts:

- `VoiceConnectionStatus.Ready` within 10 seconds;
- `AudioPlayerStatus.Playing` within 4 seconds of resource creation;
- continuous `Playing` for 30 seconds with **zero** `Buffering` re-entries;
- `playbackDuration` advanced by ≥ 29000 ms;
- clean `stop()` and `destroy()` with no lingering handles (assert via `process._getActiveHandles().length` returning to baseline).

It writes a JSON report to `evidence/voice-smoke-<timestamp>.json` and exits non-zero on any failed assertion. Run the same script in radio mode for the station stream.

**Multi-client and multi-guild test matrix.** The bot is a networked service with concurrent independent clients; isolation between them must be proven, not assumed. Run `npm run verify:voice -- --guilds 2` against **two real guilds simultaneously** (`TEST_GUILD_ID`, `TEST_GUILD_ID_2`) and assert:

- two independent `VoiceConnection`s reach `Ready` and stay `Playing` concurrently for 30 seconds;
- guild A's `jw!skip`, `jw!volume`, `jw!loop`, and `jw!stop` have **zero** observable effect on guild B's queue, volume, loop mode, or audio;
- one guild in radio mode and one in queue mode coexist, and exactly **one** `/radio/live/` poller exists in the process (assert on a poller instance counter, not on log output);
- destroying guild A's player leaves guild B playing and removes only A's entry from the registry;
- the shared `ArchiveApi` cache serves both guilds without cross-guild response bleed — guild B's search never receives guild A's result.

Separately, exercise **two distinct users in the same guild**: user 1 opens a disambiguation prompt while user 2 issues `jw!play`; user 2's numeric reply must not resolve user 1's pending prompt, and user 1's prompt must still expire cleanly. Two users issuing `jw!play` within the same 100 ms must produce one join and two queue entries in deterministic order.

Record the matrix results in `evidence/multi-guild-<timestamp>.json` and summarize it in `docs/reviews/milestone-6.md`.

**Manual evidence, captured to `evidence/` and referenced in the README:**

- Screenshots of the now-playing, queue, radio, search, and error embeds in the Discord client, in **both** Discord light and dark themes. Embed contrast in light mode is a real failure mode.
- A screen recording or timestamped log of a 10-minute session covering: play, enqueue three tracks, skip, seek, volume change, radio switch, radio stop, queue resume, stop.
- The full process log from that session, showing zero unhandled rejections and zero uncaught exceptions.

**Performance measurement**, recorded in `docs/performance.md` on the actual dev machine with the machine's specs stated: command-to-first-audio p50 and p95 over 10 `jw!play` invocations; search command round-trip p95; RSS after 30 minutes with 3 active guild players; RSS after all players are destroyed, proving no leak (within 20 MB of the pre-playback baseline).

**CI:** `.github/workflows/verify.yml` runs `npm ci && npm run verify` with `SKIP_LIVE=1` on push and pull request to `main`, on Node 22 and Node 24. CI does not run the voice smoke test — say so in the workflow comments rather than leaving it mysteriously absent.

## Critics and repair loops

Run these as explicit review passes at the named milestones. A critic that returns "looks good" has failed its job — each pass must produce a written defect list with severities in `docs/reviews/<milestone>.md`, or an explicit statement of what was checked and found clean.

- **Resolution critic** (after M2): run 30 real queries drawn from different eras and categories through `api/search.js` and record every wrong or ambiguous result in a table. Any query where a human would obviously expect a different track is a major defect.
- **Embed critic** (after M3 and M6): review the captured screenshots and enumerate concrete defects — truncation, misalignment, wrong color, unreadable contrast in light theme, missing thumbnail fallback, `undefined` in a field. Name the file and the field, not a general impression.
- **Playback critic** (after M4): listen to a real 10-minute session and report on gap length between tracks, volume consistency, skip responsiveness, stutter, and whether the embed ever disagreed with what was audible.
- **Resilience critic** (after M6): actively break things — kill the network mid-track, revoke the bot's Speak permission mid-playback, move the bot between channels, `jw!play` twice in the same 100 ms, drag the bot into a full channel, stop the archive from resolving via a hosts entry. Record actual observed behavior against the specified failure behavior above.

**Severity and exit gate.** Critical = process crash, wrong audio played, token exposure, silent failure. Major = reproducible wrong behavior in a primary flow. Minor = cosmetic or rare-path. A milestone exits when there are zero critical defects, zero reproducible major defects in the primary flow, and all milestone checks pass. Remaining minor defects are listed in `docs/known-issues.md` with a reproduction. Do not iterate indefinitely; do not claim a clean sweep you did not verify.

## Milestones

Each milestone ends with a working bot, a green `npm run verify`, a commit, and a push.

### Milestone 1 — A bot that responds
- **User-visible:** the bot is online in the test guild; `jw!ping` and `jw!help` reply; `/ping` and `/help` reply.
- **Implementation:** repo, remote, `package.json` with pinned deps, config, logger, errors, client, router, CommandContext, command registry, help generation, allowlist gating, graceful shutdown, `CLAUDE.md`, README skeleton, `.env.example`, `.gitignore`, CI workflow, `verify.mjs`, `check-secrets.mjs`.
- **Automated:** router unit tests; config validation tests; help generation test; CI green.
- **Manual evidence:** screenshot of `jw!help` and `/help`; startup log showing resolved FFmpeg path and intent status.
- **Exit gate:** both surfaces work; missing config exits non-zero with a readable message; bot leaves a non-allowlisted guild.
- **Allowed limitations:** no voice, no archive access.

### Milestone 2 — The archive is searchable
- **User-visible:** `jw!search`, `jw!song`, `jw!stats` return real archive data in real embeds.
- **Implementation:** `ArchiveApi`, `normalize.js`, `search.js`, `cache.js`, `embeds.js`, `probe-api.mjs`, captured fixtures.
- **Automated:** the full search-scoring suite; normalize edge cases; embed clamping/escaping; cache-hit request-count assertion; live integration tests.
- **Manual evidence:** screenshots of `jw!song lucid dreams` and `jw!search 999`; the resolution critic's 30-query table.
- **Exit gate:** the named acceptance queries resolve correctly; no `undefined`/`NaN` in any embed; resolution critic reports zero critical, zero major.
- **Allowed limitations:** still no voice.

### Milestone 3 — Audio comes out of a voice channel
- **User-visible:** `jw!play lucid dreams` joins and plays; `jw!stop` leaves; `jw!nowplaying` shows a live progress bar.
- **Implementation:** registry, `GuildPlayer` (single track, no queue), `source.js`, FFmpeg resolution, voice lifecycle, permission checks, `verify-voice.mjs`.
- **Automated:** guild-player state-transition tests with a fake `AudioPlayer`; source argument-construction tests; `npm run verify:voice` passing.
- **Manual evidence:** `evidence/voice-smoke-*.json`; screenshot of the now-playing embed in both themes; a 60-second recording of audible playback.
- **Exit gate:** first audio under 4 seconds; zero buffering re-entries over 30 seconds; disconnect and reconnect handled; embed critic pass complete.
- **Allowed limitations:** no queue, no seek, no volume, no radio.

### Milestone 4 — A real queue
- **User-visible:** every queue command in the table works, including seek, volume, loop, and shuffle.
- **Implementation:** `core/queue.js`, queue integration into `GuildPlayer`, disambiguation flow with timeout cleanup, per-guild async lock, idle disconnect, channel-follow.
- **Automated:** full queue reducer suite; loop/skip interaction; per-guild lock test asserting a single join under concurrent play commands; disambiguation timeout releases its listener.
- **Manual evidence:** queue embed screenshots at pages 1 and 3; the playback critic's 10-minute session report.
- **Exit gate:** gapless-enough advance (under 1.5 s between tracks); no duplicate joins under concurrency; disambiguation resolves and expires correctly; playback critic reports zero critical, zero major.
- **Allowed limitations:** no radio.

### Milestone 5 — 999 FM
- **User-visible:** `jw!radio` streams the live station; the status embed updates in place; `jw!radio stop` restores the suspended queue.
- **Implementation:** `audio/radio.js`, the single shared 15-second poller with local clock extrapolation, radio-mode gating of incompatible commands, stream reconnect backoff, degraded/offline state.
- **Automated:** poller tests with injected clock and mocked responses (track change, `is_live: false`, high `stale_seconds`, missing `up_next`); URL upgrade test asserting `http://` becomes `https://`; queue-suspend/restore test.
- **Manual evidence:** `evidence/voice-smoke-radio-*.json`; screenshots of the radio embed in playing and degraded states; a log excerpt showing a track change editing the message in place rather than reposting.
- **Exit gate:** the station is audible; the progress bar advances smoothly between polls rather than jumping every 15 s; polling stops when the last guild leaves radio mode; seek/loop/skip give clear refusals.
- **Allowed limitations:** none in scope.

### Milestone 6 — Hardened and documented
- **User-visible:** the bot survives a 60-minute mixed session with no crash and no state desync.
- **Implementation:** resilience fixes from the critic pass, complete README, complete `CLAUDE.md`, `docs/architecture.md`, `docs/decisions/`, `docs/known-issues.md`, `docs/performance.md`, invite-URL documentation with the exact required permission integer, an operations section covering deployment and log reading.
- **Automated:** full `npm run verify` green on Node 22 and 24 in CI; both voice smoke tests green.
- **Manual evidence:** resilience critic report with observed-vs-specified behavior for every failure case listed in this prompt; performance table; the complete 60-minute session log.
- **Exit gate:** every definition-of-done item below is satisfied and demonstrated.
- **Allowed limitations:** documented minor defects only.

## CLAUDE.md

Write `CLAUDE.md` at the repository root as operational instructions for a future coding agent working on this repo. It must contain, and must stay accurate as the code changes:

- One-paragraph project description and the independent-project disclaimer.
- The exact commands: `npm ci`, `npm start`, `npm run dev`, `npm run verify`, `npm run verify:voice`, `npm run precommit`.
- Required environment variables, each with purpose, format, and whether it is required.
- The module map and the state-authority rule, in the same terms as `docs/architecture.md`.
- The forbidden-coupling rules, stated as rules an agent must not break.
- The commit and push policy: verify, secret-scan, Conventional Commits, one logical change, push to `origin main`, never force-push.
- The verified API contract summary with the warning that `/radio/live/` returns an `http://` stream URL that must be upgraded.
- The explicit exclusions — no lyrics output, no downloads, no account service, no persistence — so a future agent does not "helpfully" add them.
- How to add a new command: the exact files to touch and the tests required.
- Known sharp edges: Message Content is privileged; `length` is a string; there is no ordering parameter on `/songs/`; the radio stream is unseekable and has no `Content-Length`; FFmpeg comes from `ffmpeg-static`, not PATH.

## Deliverable

`C:\GitHub\999-vault-bot`, pushed to the private `choz-dev/999-vault-bot`, containing:

- Complete `src/`, `scripts/`, and `test/` trees as specified.
- `package.json` with exact pins, `engines`, and every documented script; committed `package-lock.json`.
- `CLAUDE.md`, `README.md`, `.env.example`, `.gitignore`, `LICENSE`.
- `docs/architecture.md`, `docs/decisions/*.md`, `docs/known-issues.md`, `docs/performance.md`, `docs/reviews/*.md`.
- `.github/workflows/verify.yml`.
- `evidence/` with the voice smoke reports, screenshots, and session logs referenced by the README. Keep it under 20 MB total; link out rather than committing large video.
- A clean `git log` of small Conventional Commits, all pushed, with no secrets in history.

## Definition of done

- A fresh `git clone` on a machine with only Node ≥ 22 installed runs `npm ci` and `npm start` successfully using only `README.md`.
- `npm run verify` passes locally and in CI on Node 22 and Node 24.
- `npm run verify:voice` passes for both a queued track and the radio stream, with committed reports.
- Every command in the table works on both the prefix and slash surfaces, with matching behavior.
- `jw!play` resolves the acceptance queries to the correct tracks.
- `jw!radio` produces audible live station audio with an embed whose progress advances smoothly.
- A 60-minute mixed session produces zero unhandled rejections, zero uncaught exceptions, and no divergence between embed state and audible state.
- Every failure case enumerated in this prompt has an observed, documented behavior — not an assumed one.
- No placeholder text, no `TODO` in the primary path, no commented-out command implementations, no `console.log` outside the logger.
- No lyric text is emitted by any command.
- The token cannot be found anywhere in the repository or its history.
- `docs/known-issues.md` lists real remaining defects with reproductions, written plainly and without marketing language.

Do not report a milestone complete without the evidence that milestone requires. If something in this prompt turns out to be wrong about the live API or the Discord platform, say so explicitly, cite what you observed, and record the correction in an ADR — do not quietly build around it.

Ultracode.
