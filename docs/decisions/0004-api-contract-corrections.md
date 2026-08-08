# 0004 — Corrections to the stated archive API contract

- **Status:** accepted
- **Date:** 2026-08-07

## Context

The build brief states a verified contract for `https://juicewrldapi.com/juicewrld` and instructs
that any drift be recorded here rather than quietly built around. Every endpoint was re-probed
against the live archive on 2026-08-07 before any code was written against it.

## Confirmed exactly as stated

- `GET /health/` → `{"status":"ok"}`.
- `GET /songs/` → DRF envelope `{ count, next, previous, results }`.
- `GET /stats/` → `total_songs: 2525`, plus `category_stats` and `era_stats`.
- Categories are exactly `released`, `unreleased`, `unsurfaced`, `recording_session`.
- `GET /files/download/?path=` → **206** with `Accept-Ranges: bytes` and
  `Content-Range: bytes 0-1023/10115528`. Range is supported.
- `GET /radio/stream.mp3` → `audio/mpeg` with **no** `Content-Length` and **no** `Accept-Ranges`.
- `GET /radio/live/` returns `stream_url` as **`http://`** — the upgrade to `https://` is required,
  exactly as stated.
- `length` is a `"m:ss"` string (`"3:59"`), not seconds.
- There is no usable ordering parameter.

## Corrections

### 1. `ordering` is silently ignored, not rejected

The brief says there is "no ordering parameter". Accurate, but the failure mode is worse than
absence: `GET /songs/?searchall=lucid&ordering=title` returns **200** with an unchanged result
order. It does not 400. Code that passes `ordering` looks like it works and does not.

*Handling:* `api/client.js` never sends `ordering`, and all ranking happens client-side in
`api/search.js`. Noted in `CLAUDE.md` as a sharp edge.

### 2. `image_url` is site-relative, not absolute

The brief's canonical Song example shows `imageUrl: "https://..."`. The live value is
`"/assets/999.jpg"` — a path relative to the site origin, not the API base. Putting it into an
embed unmodified yields a broken thumbnail, and Discord silently drops the image rather than
erroring.

*Handling:* `api/normalize.js` resolves it against the site origin (`https://juicewrldapi.com`) and
returns `""` for anything that does not resolve to an https URL on that origin.

### 3. `length` and `path` are missing far more often than "sometimes"

The brief notes `length` is "sometimes empty or malformed". Measured over a 100-record page:

- **34 of 100** records have `length: ""`.
- **33 of 100** records have `path: ""` — they cannot be streamed at all.

A third of the archive is not playable. That is a design input, not an edge case.

*Handling:* records without a `path`, or without an audio extension, are dropped **before** scoring
in `api/search.js`, so search and `play` never offer a result that cannot play.
`durationSeconds: null` renders as `--:--`.

### 4. Song records carry full lyrics on every response

`GET /songs/` returns `lyrics` and `synced_lyrics` inline on every record — full lyric text, not a
link, on a plain search response. There is no query parameter to suppress them.

This makes the no-lyrics exclusion an active requirement rather than a passive one: any code that
spreads a raw record into an embed field, or logs a record at debug, would emit lyric text.

*Handling:* `api/normalize.js` constructs the canonical Song field by field and never copies
`lyrics` or `synced_lyrics`. The canonical shape has no lyric field at all, so no downstream module
— embed, log, or command — has anything to render. A test asserts this against a real fixture.

### 5. Fields present but not in the brief's list

`recording_locations`, `record_dates`, `additional_information`, `instrumentals`, `snippets`,
`bitrate`, `groupbuy_info`, `original_key`, `file_names`. Of these only `recording_locations` is
used (in the `song` metadata embed, as the brief requires "recording location").

## Consequences

`npm run probe` re-checks every one of these and exits non-zero on drift, so a future change to the
archive surfaces as a failing command rather than as a wrong embed.
