# CLAUDE.md — operating instructions for this repository

999 Vault Bot is a self-hosted Discord music bot that streams songs from the JuiceWRLDAPI archive
into a voice channel and relays the live 999 FM station. It is driven by `jw!` prefix commands with
a slash-command equivalent for every command. It is a Node.js ES-module service with no build step:
`src/index.js` runs directly. It is stateless across restarts apart from its configuration.

**999 Vault is an independent project. It is not affiliated with, endorsed by, or operated by the
JuiceWRLDAPI team. The archive source is JuiceWRLDAPI.com and is credited as such in the UI.**

---

## Commands

```bash
npm ci             # the only supported install path; the lockfile is committed
npm start          # run the bot (node --env-file-if-exists=.env src/index.js)
npm run dev        # same, under Node's built-in --watch
npm run verify     # syntax gate + full test suite; must be green before every commit
npm run verify:voice   # real gateway + real voice connection smoke test (needs a token)
npm run precommit  # staged-content secret scan; run before every commit
npm run probe      # hit every archive endpoint and report contract drift
```

`npm run verify` is the gate. If it is red, fix it before committing — do not commit a red tree and
follow up with a fix commit.

---

## Environment

Configuration comes exclusively from environment variables, loaded from `.env` by Node's built-in
`--env-file-if-exists` flag. There is no `dotenv` dependency. `.env` is gitignored; `.env.example`
is committed with every key.

| Variable | Required | Purpose / format |
|---|---|---|
| `DISCORD_TOKEN` | **yes** | Bot token. Never logged, never committed, never echoed. |
| `DISCORD_CLIENT_ID` | **yes** | Application ID, 17–20 digits. Used for slash registration. |
| `COMMAND_PREFIX` | no | Default `jw!`. No whitespace, ≤ 8 chars. Matched case-insensitively. |
| `API_BASE_URL` | no | Default `https://juicewrldapi.com/juicewrld`. Must be https. |
| `GUILD_ALLOWLIST` | no | Comma-separated guild IDs. Non-empty ⇒ leave any guild not listed. |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` \| `silent`. Default `info`. |
| `FFMPEG_PATH` | no | Absolute path to a system FFmpeg. Empty ⇒ use `ffmpeg-static`. |
| `IDLE_DISCONNECT_MS` | no | Default `300000`. Leave voice after this long alone in a channel. |
| `API_TIMEOUT_MS` | no | Default `30000`, range 1000–120000. |
| `API_RETRIES` | no | Default `4`, range 1–10. |
| `DEFAULT_VOLUME` | no | Default `100`, range 0–200. |
| `RADIO_POLL_MS` | no | Default `15000`. Station poll interval while any guild is in radio mode. |
| `TEST_GUILD_ID`, `TEST_VOICE_CHANNEL_ID` | no | Voice smoke test only. |
| `TEST_GUILD_ID_2`, `TEST_VOICE_CHANNEL_ID_2` | no | Multi-guild isolation matrix only. |

The process **exits non-zero with a single readable line** if required configuration is missing or
malformed. It must never start half-configured. Do not add a "best effort" fallback for a missing
token.

---

## Commands

Every command works on **both** surfaces — `jw!name` and `/name` — with identical behaviour, because
each is defined once in `src/bot/commands/index.js`. Aliases are prefix-only.

| Command | Aliases | Behaviour |
|---|---|---|
| `play <query\|id>` | `p` | Resolve, join the invoker's channel, enqueue. Starts if idle, else reports queue position. |
| `playnext <query\|id>` | `pn` | Same, inserted at position 1. |
| `pause` / `resume` | `unpause` | Idempotent — pausing a paused player replies "already paused". |
| `skip` | `s`, `next` | Advance. A `track` loop is cleared for this advance only. |
| `stop` | | Clear the queue, stop, leave. |
| `queue [page]` | `q` | Paginated, 10 per page, with total duration. |
| `nowplaying` | `np` | Current track, live progress bar, elapsed/total, requester. |
| `remove <n>` | `rm` | Remove queue position n. |
| `move <from> <to>` | `mv` | Reorder. |
| `clear` | | Empty the queue, keep the current track playing. |
| `shuffle` | | Fisher–Yates with an injected RNG. |
| `loop [off\|track\|queue]` | `repeat` | No argument cycles. |
| `seek <mm:ss\|seconds>` | | Restarts the source with `-ss`. Refused in radio mode. |
| `volume [0-200]` | `vol` | Per-guild, via `inlineVolume`. No argument reports. |
| `join` / `leave` | `disconnect`, `dc` | Explicit connection control. |
| `radio [stop\|status]` | `fm`, `999` | Relay 999 FM. Suspends the queue; `radio stop` resumes it. |
| `song <query>` | `info` | Metadata embed, no playback. **No lyrics.** |
| `search <query>` | `find` | Top 10 scored results with the exact `play` invocation for each. |
| `stats` | | Archive totals, uptime, guilds, active players. |
| `help [command]` | `h`, `commands` | Generated from the registry — never a maintained string. |
| `ping` | | Gateway latency, archive `/health/` latency, RSS. |

## Module map

```
src/
  index.js              composition root: config -> logger -> api -> registry -> client -> login
  config.js             env parsing, validation, frozen config object, redaction list
  core/logger.js        JSON-line logger with levels + token redaction (hand-written)
  core/errors.js        AppError taxonomy: ConfigError, ApiError, ResolveError, VoiceError, UserError
  core/result.js        ok/err helper used at module boundaries
  core/queue.js         pure queue reducer: enqueue/dequeue/remove/move/clear/shuffle/jump
  api/client.js         ArchiveApi: fetch + timeout + retry + abort + global rate gate
  api/normalize.js      raw song record -> canonical Song (pure)
  api/search.js         scoring + ranking + disambiguation (pure, no I/O)
  api/cache.js          bounded TTL LRU for search results, eras, song records
  api/resolve.js        query -> one Song or a disambiguation set
  audio/ffmpeg.js       FFmpeg binary discovery (ffmpeg-static or FFMPEG_PATH)
  audio/registry.js     Map<guildId, GuildPlayer>; the only place players are made or destroyed
  audio/guild-player.js per-guild state machine: connection, queue, current, loop, volume
  audio/source.js       Song -> AudioResource via FFmpeg (seek support, URL input)
  audio/radio.js        RadioStation: single /radio/live/ poller + stream resource construction
  bot/client.js         discord.js Client construction, intents, event wiring, lifecycle
  bot/router.js         pure: (content, prefix) -> { name, args, rest } | null
  bot/context.js        CommandContext, built identically from a message or an interaction
  bot/slash.js          pure: registry -> Discord application-command JSON
  bot/commands/index.js command registry: name, aliases, description, usage, options, execute(ctx)
  bot/commands/*.js     one file per command
  bot/embeds.js         pure embed builders; no command builds an embed inline
scripts/
  verify.mjs            syntax gate + test run; the single verification entrypoint
  verify-voice.mjs      real gateway + real voice connection smoke test
  check-secrets.mjs     staged-content secret scan
  probe-api.mjs         hits every used endpoint, prints a shape summary, exits non-zero on drift
test/
  *.test.mjs            node:test, no test framework dependency
  helpers/              fake CommandContext, fake player, mocked ArchiveApi
  fixtures/             real song records captured from the live API
```

### State authority

`GuildPlayer` is the single authority for a guild's voice connection, queue, current track, loop
mode, and volume.

- Commands **do not** mutate queues, **do not** touch a `VoiceConnection`, and **do not** construct
  an `AudioResource`. They call intent methods — `player.enqueue(song)`, `player.skip()`,
  `player.seek(seconds)` — and render the state that comes back.
- `audio/registry.js` is the **only** module that constructs or destroys a `GuildPlayer`.

### The CommandContext boundary

Every command receives a `CommandContext`:

```
{ source, guildId, channelId, userId, memberVoiceChannelId, getMemberVoiceChannel(),
  args, rest, reply(payload), editReply(payload), defer(), deps }
```

It is built identically from a `messageCreate` event and from a `ChatInputCommandInteraction`.
Commands import nothing from `discord.js`. This is what makes most behaviour testable without a
gateway: a test builds a fake context, runs the command against a mocked `ArchiveApi` and a fake
player, and asserts on the captured reply payload.

Services reach commands through `ctx.deps` — never through a module-level singleton and never by
importing `api/client.js` directly.

### Data flow

```
Discord event -> router/interaction -> CommandContext -> command
              -> (ArchiveApi | GuildPlayer) -> state -> embeds -> ctx.reply
```

One direction. Nothing flows backward.

---

## Rules you must not break

These are enforced by `test/boundaries.test.mjs`. If you need to break one, the architecture is
wrong — fix the architecture, not the test.

1. `bot/commands/*` may not import `@discordjs/voice`, `node:http`/`node:https`/`undici`,
   `audio/source.js`, `api/client.js`, or `discord.js`.
2. `api/*` may not import anything from `bot/` or `audio/`.
3. `core/queue.js`, `api/search.js`, `api/normalize.js`, `bot/embeds.js`, `bot/router.js`, and
   `bot/slash.js` must stay pure: no `discord.js`, no I/O, no timers, no `Math.random`. Randomness
   is injected (`shuffle` takes an RNG) so it is testable.
4. Only `core/logger.js` may call `console.*`.
5. Only `src/index.js` may read `process.env`. Everything else receives config as an argument.
6. Every dependency is pinned exactly — no `^`, no `~`. The direct-dependency budget is 8.

---

## Commit and push policy

After **every** logical change:

1. `npm run verify` — must be green.
2. `npm run precommit` — staged secret scan, must exit 0.
3. Commit with a [Conventional Commits](https://www.conventionalcommits.org/) message. One logical
   change per commit.
4. `git push origin main`.

Never `--force`. Never `--no-verify`. Never commit `node_modules/`, `.env`, audio files, or evidence
binaries over 2 MB.

---

## Verified API contract

Base `https://juicewrldapi.com/juicewrld`. Verified live on 2026-08-07; re-run `npm run probe`
before coding against anything not listed here.

| Endpoint | Shape |
|---|---|
| `GET /health/` | `{ "status": "ok" }` |
| `GET /songs/` | DRF paginated `{ count, next, previous, results: [...] }` |
| `GET /songs/{id}/` | one song record |
| `GET /stats/` | `{ total_songs, category_stats, era_stats }` — 2525 songs at time of writing |
| `GET /eras/`, `GET /categories/`, `GET /playable_songs/` | reference data |
| `GET /files/download/?path=` | `audio/mpeg`, **supports Range** (verified 206 + `Content-Range`) |
| `GET /files/cover-art/?path=`, `GET /files/image-thumbnail/?path=&size=` | raw image bytes |
| `GET /radio/live/` | station status (see below) |
| `GET /radio/stream.mp3` | continuous `audio/mpeg`, **no** `Content-Length`, **no** `Accept-Ranges` |

Working `/songs/` query parameters: `searchall`, `page`, `page_size`, `category`, `era` (era **name**,
not id), `file_names_array=true`.

### ⚠️ `/radio/live/` returns an `http://` stream URL

`stream_url` comes back as **`http://juicewrldapi.com/juicewrld/radio/stream.mp3`**. Upgrade it to
`https://` before use, exactly as the desktop client does. Never fetch archive audio over cleartext.
This is handled in `audio/radio.js`; do not bypass it.

---

## Explicit exclusions — do not "helpfully" add these

- **No lyrics output.** The API returns `lyrics` and `synced_lyrics` on every song record. The bot
  must never post lyric text to Discord. `api/normalize.js` drops both fields at the boundary so
  nothing downstream can render them, and a test asserts the canonical Song shape has no lyric
  field. This is a deliberate copyright decision, not an oversight. Metadata embeds only.
- **No downloads, zip jobs, or file sharing.** `/files/zip-*`, `/start-zip-job/`, `/files/share/`
  are out of scope.
- **No 999 Vault account service.** No Discord OAuth login, no synced likes, no cloud playlists, no
  listening-event upload.
- **No persistence.** No database. Volume, loop mode, and queue are in-memory and reset on restart.
- **No radio voting.** `/radio/live/` exposes a `vote` object; there is no verified write contract
  for it, so there is no voting command.
- **No unverified writes.** `POST /plays/` exists but its payload contract has not been confirmed
  against a live request. Do not post play events.
- **No analytics that phone home**, no public bot listing, no vanity invite page.

---

## Adding a new command

1. Create `src/bot/commands/<name>.js` exporting a default object:
   `{ name, aliases, category, description, usage, options, guildOnly, execute(ctx) }`.
   - `usage` templates the prefix as `{prefix}`.
   - `options` are discord.js-free slash option specs in `rest` order:
     `{ name, description, type: "string"|"integer"|"boolean", required, min, max, choices }`.
     Reading them back in order reproduces exactly the `rest` string a prefix invocation produces,
     so both surfaces share one parsing path.
2. Add it to the `COMMANDS` array in `src/bot/commands/index.js`. Help and slash registration are
   generated from that array — there is no second list to update.
3. Build every embed in `src/bot/embeds.js`. Never construct one inline in a command.
4. Tests, in `test/commands-*.test.mjs`:
   - the happy path, asserting on the reply payload;
   - the not-in-voice path, if it touches audio;
   - the no-results path, if it touches the archive;
   - any argument-validation rejection.
   Use `test/helpers/context.mjs` to build the fake context.
5. `npm run verify`, `npm run precommit`, commit, push.

---

## Known sharp edges

- **Message Content is a privileged intent.** It must be enabled manually at Developer Portal → your
  application → Bot → Privileged Gateway Intents. If it is off, the gateway **refuses the connection
  outright** rather than silently delivering empty messages — so `bot/client.js` catches that
  rejection at login, logs one clear warning naming the toggle, and reconnects without the intent in
  slash-only mode. Unverified bots are capped at 100 guilds.
- **`length` is a `"m:ss"` string, not seconds** — and it is empty on roughly a third of records.
  Parse defensively. `durationSeconds: null` renders as `--:--`, never `NaN:NaN`.
- **Roughly a third of records have no `path`** and cannot be played. They are dropped before
  scoring, so search never offers an unplayable result.
- **There is no ordering parameter on `/songs/`.** Passing `ordering` is silently ignored — it does
  not error, so it is easy to believe it worked. Sort client-side.
- **`image_url` is a site-relative path** (`/assets/999.jpg`), not an absolute URL. Resolve it
  against the site origin before putting it in an embed.
- **The radio stream is unseekable, has no `Content-Length`, and never ends.** Do not treat it like
  a file. `seek`, `loop`, `skip`, and queue operations refuse in radio mode with an explanation.
- **FFmpeg comes from `ffmpeg-static`, not PATH.** It is not on PATH on the development machine.
  The resolved path and version are logged at startup.
- **Native opus is optional.** `@discordjs/opus` has no prebuild for every Node ABI (it fails to
  build on Node 26), so it is an `optionalDependency` and `opusscript` is a required pure-JS
  fallback. The startup log states which one is active. See
  `docs/decisions/0003-opus-fallback.md`.
- **Voice encryption uses `@noble/ciphers`** — pure JS, no native toolchain. Do not add
  `sodium-native`, `libsodium-wrappers`, or `tweetnacl` without recording a real observed failure in
  an ADR first.
