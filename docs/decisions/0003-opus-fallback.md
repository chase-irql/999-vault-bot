# 0003 — `@discordjs/opus` is optional; `opusscript` is required

- **Status:** accepted
- **Date:** 2026-08-07

## Context

The build brief pins `@discordjs/opus` to 0.10.0 as a production dependency, "with a documented
fallback to `opusscript` if the native prebuild is unavailable on the target machine."

That case is not hypothetical here. On the development machine — Windows 11, **Node v26.3.1** —
`npm install` fails outright:

```
prebuild-install ... node-v147-napi-v3-win32-x64-unknown-unknown  (no prebuild)
gyp ERR! stack Error: MSBuild.exe failed with exit code: 1
node-pre-gyp ERR! not ok
npm error ... exit code 1
```

`@discordjs/opus@0.10.0` ships no prebuild for Node 26's ABI (`NODE_MODULE_VERSION 147`), so
`node-pre-gyp` falls back to compiling from source, and the source build fails. Because it was a
regular `dependency`, the whole install failed — `npm ci` could not complete at all, which breaks
the definition of done ("a fresh clone runs `npm ci` and `npm start` successfully").

## Decision

Move `@discordjs/opus` to `optionalDependencies` and add `opusscript` as a required dependency.

```json
"dependencies":         { ..., "opusscript": "0.0.8" },
"optionalDependencies": { "@discordjs/opus": "0.10.0" }
```

npm skips an `optionalDependency` whose install fails rather than failing the whole install, so:

- on a machine where the native prebuild exists, `@discordjs/opus` installs and `prism-media`
  selects it — the fast path is unchanged;
- on a machine where it does not, the install still succeeds and `prism-media` falls through to
  `opusscript`.

`opusscript` is pinned to **0.0.8**, not 0.1.x, because `prism-media@1.3.5` declares
`peerOptional opusscript@"^0.0.8"`; 0.1.1 is rejected by npm's peer resolution with `ERESOLVE`.

The startup log reports which implementation is active, so the answer is in the first ten lines of
any log rather than something to infer.

## Consequences

- Direct dependency count is 7 (6 required + 1 optional), inside the budget of 8.
- `opusscript` is pure JS and measurably slower than the native encoder. For ≤ 5 guilds with one
  stream each this is acceptable; the CPU cost is per-stream and small at this scale. If a
  deployment ever runs enough concurrent streams to feel it, the fix is to install a Node version
  with a matching `@discordjs/opus` prebuild — no code change.
- `test/deps.test.mjs` asserts both packages are declared in their respective sections, so nobody
  "cleans up" the fallback and reintroduces a hard install failure.
- Verified: with `@discordjs/opus` absent, `node_modules/opusscript` is present and `npm ci`
  completes cleanly on Node 26.3.1 / Windows 11.
