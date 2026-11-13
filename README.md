# 999 Vault Bot

A self-hosted Discord music bot that streams the JuiceWRLDAPI archive, direct YouTube video links,
and the live 999 FM station into voice channels. Driven entirely by `jw!` prefix commands.

> **999 Vault is an independent project.** It is not affiliated with, endorsed by, or operated by
> the JuiceWRLDAPI team. The archive source is **[JuiceWRLDAPI.com](https://juicewrldapi.com)** and
> is credited in the bot's embeds.

---

## Requirements

- **Node.js ≥ 22.9.0.** Developed and measured on **v26.3.1** (Windows 11 Pro 10.0.19045).
  The floor is 22.9.0 rather than 22.0.0 because `--env-file-if-exists` landed there — see
  [ADR 0002](docs/decisions/0002-node-engine.md).
- A Discord application with a bot user.
- **No compiler and no system FFmpeg required.** FFmpeg ships via `ffmpeg-static`; voice encryption
  is pure JS via `@noble/ciphers`.
- For YouTube playback, install a current [official yt-dlp release](https://github.com/yt-dlp/yt-dlp/releases/latest)
  with the bundled YouTube challenge scripts. Put it on `PATH` or set `YT_DLP_PATH` to the executable.
  The bot uses its existing Node.js runtime with yt-dlp.

## Install and run

```bash
git clone https://github.com/choz-dev/999-vault-bot.git
cd 999-vault-bot
npm ci
cp .env.example .env      # then fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
npm start
```

On Windows PowerShell, use `Copy-Item .env.example .env` for the copy step.

| Script | What it does |
|---|---|
| `npm ci` | The only supported install path. The lockfile is committed; every dep is pinned exactly. |
| `npm start` | Run the bot. |
| `npm run dev` | Same, under Node's built-in `--watch`. |
| `npm run verify` | Syntax gate + the full test suite. The gate for every commit. |
| `npm run verify:voice` | Real gateway + real voice smoke test. Needs a token and a test channel. |
| `npm run precommit` | Staged-content secret scan. |
| `npm run probe` | Re-check every archive endpoint and report contract drift. |

## Discord setup

1. **Create the application** at the [Developer Portal](https://discord.com/developers/applications).
   Copy the *Application ID* — you need it for the invite URL below. Putting it in
   `DISCORD_CLIENT_ID` is optional; nothing at runtime reads it.
2. **Bot → Reset Token**, copy it into `DISCORD_TOKEN`. Never commit it.
3. **Bot → Privileged Gateway Intents → enable "Message Content Intent."**
   **This is mandatory, not optional.** `jw!` is the only command surface, so without this intent the
   bot has no commands at all. If it is off the gateway *refuses the connection outright* — the bot
   detects that, logs one warning naming this exact toggle, and reconnects without it rather than
   crash-looping. It will sit there online and inert until you turn it on.
4. Also set **Public Bot → OFF** and leave **Requires OAuth2 Code Grant → OFF**. Leave *Server
   Members* and *Presence* intents off; nothing in scope needs them.
5. **Invite the bot** with the `bot` scope and permission integer **`3230720`**:

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3230720&scope=bot
   ```

   That integer is exactly: View Channels (1024) + Send Messages (2048) + Embed Links (16384) +
   Read Message History (65536) + Connect (1048576) + Speak (2097152). Nothing else is requested.

   The `applications.commands` scope is **not** needed — there are no slash commands. If you already
   invited the bot with it, nothing breaks; the scope just goes unused.

6. **Restrict it.** This bot is built for private servers. Set `GUILD_ALLOWLIST` to your guild IDs —
   the bot leaves any guild not on the list immediately after joining.

### Restricting commands to certain channels

By default commands work in **every channel the bot can see**. Two ways to change that:

- **Channel permission overwrites.** Deny the bot **View Channel** where you don't want it. It stops
  receiving those messages entirely — nothing reaches the bot at all. This is the only real
  enforcement.
- **`CHANNEL_ALLOWLIST`** in `.env` — comma-separated channel IDs. For channels the bot must still be
  able to read but should not take commands in. Outside the allowlist, `jw!` commands are ignored
  silently, because replying "wrong channel" in the wrong channel is the noise you were trying to
  avoid.

  ```
  CHANNEL_ALLOWLIST=1040000000000000010,1040000000000000011
  ```

  Treat this as convenience, not access control: the message still reaches the process. For anything
  you actually need enforced, use permission overwrites.

Note that **Server Settings → Integrations → Command Permissions has no effect here** — that feature
only governs slash commands, and this bot has none.

## Commands

The prefix is case-insensitive, so `JW!play` works. There are no slash commands — see
[ADR 0006](docs/decisions/0006-prefix-only.md).

| Command | Aliases | What it does |
|---|---|---|
| `jw!play <query\|id\|YouTube URL>` | `p` | Play or queue an archive track or a direct YouTube video link. |
| `jw!playnext <query\|id\|YouTube URL>` | `pn` | Put the track next in line. |
| `jw!random [stop]` | `endless` | Endless random archive shuffle; stop restores your suspended queue. |
| `jw!pause` / `jw!resume` | `unpause` | Pause and resume. |
| `jw!skip` | `s`, `next` | Next track. |
| `jw!stop` | | Clear the queue and leave. |
| `jw!queue [page]` | `q` | Show the queue, ten per page. |
| `jw!nowplaying` | `np` | Current track with a live progress bar. |
| `jw!remove <n>` / `jw!move <from> <to>` | `rm`, `mv` | Edit the queue. |
| `jw!clear` | | Empty the queue, keep playing. |
| `jw!shuffle` | | Shuffle the queued tracks. |
| `jw!loop [off\|track\|queue]` | `repeat` | Loop mode; no argument cycles. |
| `jw!seek <mm:ss>` | | Jump within the current track. |
| `jw!volume [0-200]` | `vol` | Set or report volume. |
| `jw!join` / `jw!leave` | `dc` | Connect or disconnect. |
| `jw!radio [stop\|status]` | `fm`, `999` | Relay the live 999 FM station. |
| `jw!song <query>` | `info` | Archive metadata, no playback. |
| `jw!search <query>` | `find` | Top matches, each with its exact `play` command. |
| `jw!stats` | | Archive totals and bot status. |
| `jw!help [command]` | `h` | Everything above, generated from the registry. |
| `jw!ping` | | Latency and memory. |

**YouTube.** Try `jw!play https://youtu.be/jNQXAC9IVRw`. Watch, share, Shorts, live, embed, and clip
links play audio from the linked YouTube video. A video link with a playlist parameter plays the
single video. The Pi or other bot host must be able to open the video without signing in.

**Ambiguous titles.** The archive holds 2,500+ entries with alternate titles, working titles and
leaked variants. When several genuinely match, `play` shows a numbered list — reply with a number
within 60 seconds, or run `jw!play <id>` with the id shown. Only *your* number resolves *your*
prompt.

**Radio suspends, it does not clear.** `jw!radio` puts the queue aside and streams the station;
`jw!radio stop` resumes the track you were on, at the position you left it. While the station plays,
`seek`, `loop`, `skip` and queue edits refuse with an explanation — it is a live stream. `pause`,
`volume` and `stop` still work.

**Endless shuffle also suspends instead of clearing.** `jw!random` immediately switches to a
random playable archive track, keeps eight distinct tracks ready ahead, and avoids the eight most
recent tracks. `jw!random stop` resumes the interrupted track at its previous position with the
original queue and loop mode intact. `jw!stop` ends both the shuffle and the suspended queue.

## Configuration

Every setting is an environment variable, read from `.env` via Node's built-in
`--env-file-if-exists` flag. There is no `dotenv` dependency. `.env` is gitignored;
[`.env.example`](.env.example) is committed with every key. Full table in
[CLAUDE.md](CLAUDE.md#environment).

The process exits non-zero with a single readable line if configuration is missing or malformed. It
never starts half-configured.

## Dependencies

Seven direct packages (six required, one optional), each pinned exactly. The budget is 8 and is
asserted by a test.

| Package | Why it is here |
|---|---|
| `discord.js` 14.27.0 | Gateway, REST, both command surfaces. v14 is the released line; v15 is an unreleased dev build and is not used. |
| `@discordjs/voice` 0.19.2 | Voice connection and `AudioPlayer` lifecycle. Nothing else implements the voice gateway. |
| `prism-media` 1.3.5 | FFmpeg process wrapper producing a stream the voice layer can consume. |
| `@noble/ciphers` 2.2.0 | Voice encryption in pure JS — no native toolchain, so a fresh clone installs without Visual Studio. |
| `ffmpeg-static` 5.3.0 | FFmpeg is **not** on PATH on the dev machine. Ships a prebuilt binary and exports its absolute path. |
| `opusscript` 0.0.8 | Pure-JS Opus encoder — the always-available fallback. |
| `@discordjs/opus` 0.10.0 *(optional)* | Native Opus when a prebuild exists for the running Node ABI. |

**Which Opus encoder am I using?** The startup log says so directly. `@discordjs/opus` has no
prebuild for Node 26 and fails to compile there, which is why it is optional and `opusscript` is
required — see [ADR 0003](docs/decisions/0003-opus-fallback.md). To check by hand:

```bash
node -e "try{require('@discordjs/opus');console.log('native @discordjs/opus')}catch{console.log('opusscript fallback')}"
```

Deliberately absent: a logging framework, a validation framework, an ORM, a web framework, a
scheduler, and a test framework. Each is replaced by a small amount of code in this repo — see
[ADR 0001](docs/decisions/0001-stack.md).

## Excluded on purpose

These are **not** missing features. They are decisions, listed so nobody adds them back as a favour:

- **No lyrics output.** The archive returns full `lyrics` and `synced_lyrics` on every song record.
  The bot never posts lyric text. `api/normalize.js` drops both fields at the API boundary, so the
  canonical song shape has no lyric field for anything downstream to render. Deliberate copyright
  decision. Metadata embeds only.
- **No downloads, zip jobs, or file sharing.**
- **No 999 Vault account service** — no OAuth login, no synced likes, no cloud playlists, no
  listening-event upload.
- **No persistence.** No database. Volume, loop mode, and queue live in memory and **reset on
  restart**.
- **No radio voting**, and no writes to `POST /plays/` — neither has a verified write contract.
- **`discord_listeners`** from `/radio/live/` is read-only here and otherwise unused; there is no
  verified route to register a listener, so the bot does not try.

## Status — what is and is not verified

Being direct about this, because a music bot that has never been heard is not a finished music bot.

**Verified.** 408 automated tests pass (`npm run verify`) — song resolution scored against 145 real
records captured from the live archive, the queue reducer, the player state machine driven through
every transition with fake voice primitives, guild isolation, disambiguation across two users,
embed limits and escaping, and the archive failure paths. `npm run probe` confirms every endpoint
this bot uses still matches the documented contract. Archive search round-trip measured at
p50 176 ms / p95 292 ms — see [docs/performance.md](docs/performance.md).

**Not verified.** This build had **no Discord bot token**, so nothing has been run against a live
gateway. Specifically not done: `npm run verify:voice` (so no audio has actually been heard), the
two-guild live isolation matrix, embed screenshots in light and dark themes, the 60-minute mixed
session, and every command-to-first-audio timing number. `evidence/` is empty, which is the honest
state rather than an oversight.

The scripts for all of it are written and assert rather than merely record. With a token and a test
channel in `.env`:

```bash
npm run verify:voice
```

Full accounting in [docs/known-issues.md](docs/known-issues.md) and
[docs/reviews/](docs/reviews/). Four defects were found and fixed during review — including one
critical bug where the archive retry policy was unreachable code, and one where a late decoder
failure silently ate a track. Both now have regression tests.

## Documentation

- [CLAUDE.md](CLAUDE.md) — operating instructions, module map, rules, API contract, sharp edges.
- [docs/architecture.md](docs/architecture.md) — the three boundaries the design rests on.
- [docs/decisions/](docs/decisions/) — ADR log, including corrections to the stated API contract.
- [docs/known-issues.md](docs/known-issues.md) — real remaining defects, with reproductions.

## Licence

MIT — see [LICENSE](LICENSE).
