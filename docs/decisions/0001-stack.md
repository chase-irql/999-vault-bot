# 0001 — Stack and runtime

- **Status:** accepted
- **Date:** 2026-08-07

## Context

A Discord music bot for a handful of private guilds. It has to stream MP3 from an HTTP archive into
a voice channel, run on Windows 11 for development and Linux x64 for deployment from the same
commands, and be maintainable by one person.

## Decision

Node.js ES modules, no TypeScript, no build step, no bundler. `src/index.js` runs directly.

Six required dependencies plus one optional, every one pinned exactly:

| Package | Version | Why |
|---|---|---|
| `discord.js` | 14.27.0 | Gateway, REST, and command surfaces. v14 is the released line; v15 is an unreleased dev build and is not used. |
| `@discordjs/voice` | 0.19.2 | Voice connection and `AudioPlayer` lifecycle. Nothing else implements the voice gateway. |
| `prism-media` | 1.3.5 | FFmpeg process wrapper producing a stream `@discordjs/voice` can consume. |
| `@noble/ciphers` | 2.2.0 | Voice encryption in pure JS — no native toolchain, so a fresh clone installs on Windows without Visual Studio. |
| `ffmpeg-static` | 5.3.0 | FFmpeg is **not** on PATH on the development machine (verified). This ships a prebuilt binary and exports its absolute path. |
| `opusscript` | 0.0.8 | Opus encoding fallback. See ADR 0003. |
| `@discordjs/opus` | 0.10.0 | *optional* — native Opus when a prebuild exists. See ADR 0003. |

Explicitly **not** added: a logging framework, a validation framework, an ORM, a web framework, a
scheduler, or a test framework. Each would replace something between 30 and 150 lines long:

- Logging → `core/logger.js`, ~90 lines, and it gains mandatory token redaction that a generic
  logger would not have.
- Validation → `config.js`, which validates the ~15 keys this service actually has.
- Test framework → `node:test` and `node:assert`, built in since Node 18.
- Scheduler → one `setInterval` in `audio/radio.js`.
- ORM / web framework → there is no database and no HTTP server.

Configuration is loaded by Node's built-in `--env-file-if-exists` flag rather than `dotenv`.

## Consequences

- `npm ci` on a clean machine needs no compiler. The one package that wants a native toolchain is
  optional and degrades to pure JS.
- No build step means no source maps to keep in sync and no stale `dist/`; the file in the stack
  trace is the file on disk.
- No TypeScript means types are documented in JSDoc and enforced by tests instead of a compiler.
  Accepted knowingly: the value a compiler adds here is mostly at module boundaries, and those are
  covered by `test/boundaries.test.mjs` and the pure-function suites.
- The dependency budget (8 direct) is asserted by `test/deps.test.mjs`, so it cannot drift quietly.
