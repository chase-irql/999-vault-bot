# 999 Vault Bot

A self-hosted Discord music bot that streams any song in the JuiceWRLDAPI archive into a voice
channel and relays the live 999 FM station. Driven by `jw!` prefix commands, with a slash-command
equivalent for every command.

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
   Copy the *Application ID* into `DISCORD_CLIENT_ID`.
2. **Bot → Reset Token**, copy it into `DISCORD_TOKEN`. Never commit it.
3. **Bot → Privileged Gateway Intents → enable "Message Content Intent."**
   This is required for the `jw!` prefix surface. If it is off, the gateway *refuses the connection
   outright* — the bot detects that, logs one warning naming this toggle, and reconnects in
   **slash-only mode** rather than appearing to work while ignoring every message.
4. **Invite the bot** with the scopes `bot` and `applications.commands` and permission integer
   **`3230720`**:

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3230720&scope=bot%20applications.commands
   ```

   That integer is exactly: View Channels (1024) + Send Messages (2048) + Embed Links (16384) +
   Read Message History (65536) + Connect (1048576) + Speak (2097152). Nothing else is requested.

5. **Restrict it.** This bot is built for private servers. Set `GUILD_ALLOWLIST` to your guild IDs —
   the bot leaves any guild not on the list immediately after joining.

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

## Documentation

- [CLAUDE.md](CLAUDE.md) — operating instructions, module map, rules, API contract, sharp edges.
- [docs/architecture.md](docs/architecture.md) — the three boundaries the design rests on.
- [docs/decisions/](docs/decisions/) — ADR log, including corrections to the stated API contract.
- [docs/known-issues.md](docs/known-issues.md) — real remaining defects, with reproductions.

## Licence

MIT — see [LICENSE](LICENSE).
