# 0005 — FFmpeg is spawned directly, not through `prism.FFmpeg`

- **Status:** accepted
- **Date:** 2026-08-07

## Context

The build brief specifies two things that turn out to conflict:

1. "Build the `AudioResource` in `audio/source.js` by invoking FFmpeg via `prism-media`."
2. "`ffmpeg` is **not** on PATH on the development machine (verified). Depend on `ffmpeg-static` and
   resolve the binary path explicitly rather than assuming PATH. Provide an env override
   `FFMPEG_PATH` for hosts that ship a system FFmpeg."

`prism-media@1.3.5` resolves its own binary and provides no way to pass one in. From
`node_modules/prism-media/src/core/FFmpeg.js`:

```js
static getInfo(force = false) {
  if (FFMPEG.command && !force) return FFMPEG;
  const sources = [() => {
    const ffmpegStatic = require('ffmpeg-static');
    return ffmpegStatic.path || ffmpegStatic;
  }, 'ffmpeg', 'avconv', './ffmpeg', './avconv'];
  ...
}

static create({ args = [], shell = false } = {}) {
  return ChildProcess.spawn(FFmpeg.getInfo().command, args.concat(['pipe:1']), ...);
}
```

The command comes from a hardcoded search order and a module-level cache. There is no option, no
setter, and no environment variable. `FFMPEG_PATH` is therefore **unimplementable** through
`prism.FFmpeg` — requirement 2 cannot be satisfied while obeying requirement 1 literally.

## Decision

Spawn FFmpeg directly in `audio/source.js` using the path resolved by `audio/ffmpeg.js`
(`FFMPEG_PATH`, else `ffmpeg-static`), and wrap its stdout in `createAudioResource` with
`inputType: StreamType.Raw` and `inlineVolume: true`.

Requirement 2 wins because it is the one with an observable failure mode: an operator on a host with
a tuned system FFmpeg sets `FFMPEG_PATH`, and it would be silently ignored.

`prism-media` remains a pinned direct dependency and is not dead weight — `@discordjs/voice`
requires it for Opus encoding, so it is loaded either way.

## What is kept from the prism approach

Everything that mattered was in the arguments, not the wrapper:

- `-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5` before `-i`
- `-analyzeduration 0`
- `-ss <seconds>` before `-i` for fast input seeking
- `-f s16le -ar 48000 -ac 2` output to `pipe:1`
- `StreamType.Raw` with `inlineVolume: true`

`buildFfmpegArgs` is pure and exported, so the exact argv — including the ordering constraints,
which are easy to get subtly wrong and hard to notice at runtime — is asserted by unit tests without
spawning anything.

## Consequences

- ~40 extra lines in `audio/source.js` covering spawn, bounded stderr capture, and teardown.
- Full control of the binary: the resolved path and version are logged at startup, and `FFMPEG_PATH`
  works.
- The process is killed with `SIGKILL` on skip/stop, so `close` handlers distinguish a deliberate
  stop (signal present) from a genuine failure (non-zero exit, no signal). Without that, every skip
  would look like a decoder crash.

## Related deviation: `-loglevel`

The brief specifies `-loglevel 0` **and** requires FFmpeg's stderr to be logged at debug when it
exits non-zero. At level 0 there is no stderr to log — the two cannot both hold.

Resolution: `-loglevel 0` normally, `-loglevel error` when the configured log level is `debug`. The
default behaviour is as specified, and the diagnostic requirement becomes achievable when an
operator actually asks for diagnostics.
