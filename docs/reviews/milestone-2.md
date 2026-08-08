# Milestone 2 review — the archive is searchable

**Date:** 2026-08-07
**Reviewer hat:** API owner, then resolution critic
**Scope:** `api/client.js`, `api/normalize.js`, `api/search.js`, `api/cache.js`, `api/resolve.js`,
`bot/embeds.js`, and the `search` / `song` / `stats` commands.

---

## Resolution critic — 30 real queries

Run against the **live archive** (not fixtures) through the full pipeline: `ArchiveApi` →
`normalize` → `search` → `resolveRanking`. Queries were chosen across released, unreleased and
session material, across eras, and deliberately including version-heavy titles.

`one` = played directly. `many` = disambiguation prompt. `none` = no match.

| Query | Outcome | Resolved to | Category | Era | Score |
|---|---|---|---|---|---|
| `lucid dreams` | one | Lucid Dreams | released | GB&GR | 1000 |
| `all girls are the same` | one | AGATS (Pt. 1) | released | GB&GR | 950 |
| `robbery` | one | Robbery | released | Mainstream | 1000 |
| `righteous` | one | Righteous | released | Mainstream | 1000 |
| `wishing well` | one | Wishing Well | released | LND | 1000 |
| `come and go` | one | Come & Go | released | LND | 1000 |
| `legends` | one | Legends | released | FD (DDE) | 1000 |
| `armed and dangerous` | one | Armed And Dangerous | released | GB&GR | 1000 |
| `hear me calling` | one | Hear Me Calling | released | Mainstream | 1000 |
| `black & white` | one | Black & White | released | GB&GR | 1000 |
| `lean wit me` | one | Lean With Me | released | GB&GR | 950 |
| `candles` | one | Candles | released | GB&GR | 1000 |
| `empty` | one | Empty | released | DRFL | 1000 |
| `fast` | one | Fast | released | DRFL | 1000 |
| `bandit` | many | Bandit (with YoungBoy…) / Bandit (v2) / … | released | — | 700 |
| `godzilla` | many | Godzilla (feat. Juice WRLD) ×2 / … [v2] | released | — | 700 |
| `conversations` | one | Conversations | released | LND | 1000 |
| `flaws and sins` | one | Flaws And Sins | released | DRFL | 1000 |
| `hate the other side` | many | …(with Polo G) [feat. The Kid LAROI] / [v1] / [v2] | released | — | 700 |
| `titanic` | one | Titanic | released | LND | 1000 |
| `bad day` | many | Bad Day (v1) / Bad Day (v2) | unreleased | — | 700 |
| `999` | one | 999 | unreleased | GB&GR | 1000 |
| `misery` | one | Sad Thing | unreleased | GB&GR | 950 |
| `sometimes` | one | Sometimes | released | FD (DDE) | 1000 |
| `no love` | one | No Love, No Trust 999 (v2) | unreleased | ND | 700 |
| `outsiders` | none | — | — | — | 0 |
| `juice wrld speaks from heaven` | many | …(Outro) / [v1] / [v2] | released | — | 700 |
| `cigarettes` | one | Cigarettes | released | Mainstream | 1000 |
| `rider` | one | Rider | released | DRFL | 1000 |
| `shorty` | many | Shorty (with Future) / [v2] / [v4] | released | — | 700 |

**Distribution:** 23 resolved directly, 6 prompted for disambiguation, 1 no match.

Every `many` outcome is a case where the archive genuinely holds several near-identical entries
(`v1`/`v2`, remixes, features) and a human would also have had to ask. None of them is the scorer
failing to separate obviously different tracks.

---

## Defects found

### D-1 — `play 999` resolved to song id 999, not the track called "999" (**Critical**, fixed)

The pipeline treated any bare integer as an id and short-circuited. The archive contains a track
literally titled **999**, and `/songs/999/` is a *different, unrelated* record — "Fine China (with
Future)".

**Observed:** `999` → `Fine China (with Future)`, resolved via the id path.
**Expected:** the track named `999`.

This is the "wrong audio played" class: the bot would have confidently played a different song from
the one the user named, with a now-playing embed that agreed with itself and was wrong. It is
exactly the failure the brief's first experience pillar exists to prevent.

**Fix:** `api/resolve.js` now runs the id lookup and the text search concurrently for a numeric
query and prefers the text result when it reaches exact-alias quality (≥ 950). A number that is not
also a title — `94034` — still resolves by id, and that path is covered by its own test.

**Regression tests:** `commands-archive.test.mjs` → "a numeric query that is also a real title
prefers the title over the id", and "a numeric query with no title match still resolves by id".

### D-2 — `&` did not match the word "and" (**Major**, fixed)

`come and go` scored only 200 (a weak substring hit) against the archive's title `Come & Go`,
because punctuation stripping turned `&` into whitespace before comparison. It happened to resolve
correctly only because nothing else matched at all.

**Fix:** `normalizeQuery` expands `&` to `and` before stripping punctuation. `come and go` now
scores 1000. Covered by a test asserting `normalizeQuery("Come & Go") === normalizeQuery("come and
go")`.

### D-3 — `all girls are the same` displays as "AGATS (Pt. 1)" (**Minor**, not fixed)

The *recording* is correct — it is the released GB&GR track, matched at 950 on an exact alias. The
displayed title is the archive's own abbreviation, because the canonical title is taken from
`track_titles[0]`.

Not fixed, deliberately: the desktop 999 Vault client picks the title the same way, and diverging
would mean the same query displays two different names in the two apps. The alias line in the
`song` embed shows the full name. Logged in `known-issues.md`.

### D-4 — `misery` resolves to "Sad Thing" (**Minor**, working as designed)

"Sad Thing" carries an exact archive alias `Misery`, which scores 950 and beats a prefix match on
`Misery Avenue` (700). Defensible — the archive asserts the alias — but a user may have meant the
other track. Both are reachable via `search`, which lists them together. No change.

### D-5 — `outsiders` returns no match (**Minor**, upstream data)

"Outsiders" is an era/album name, not a track title, and nothing is titled that. The no-results
embed names the term, suggests alternate titles, and states the archive size rather than replying
with a bare not-found. No change; era-based browsing is out of scope.

---

## What else was checked and found clean

- **No `undefined`, `NaN`, or `null` in any embed.** Asserted structurally by `assertNoJunk` across
  every builder, plus a sweep normalizing all 145 fixture records and scanning the JSON.
- **Discord limits.** A deliberately oversized fixture (9,000-character title, album, artist,
  producers, 60 aliases) is pushed through `songEmbed`, `nowPlayingEmbed`, `searchEmbed`,
  `disambiguationEmbed` and `queueEmbed`; every field is asserted against the documented ceilings.
  A 4,097-character description cannot reach Discord.
- **Markdown escaping.** Archive titles containing `*`, `_` and backticks are escaped. Parentheses
  are deliberately *not* escaped — they are not Discord formatting.
- **Unplayable records never offered.** 43 of the 145 fixtures have no usable path. A test searches
  for each one by its own title and asserts it is absent from the results.
- **Cache behaviour.** The same query twice inside the TTL issues exactly one HTTP request
  (asserted on a request counter, not inferred). Concurrent misses share one in-flight call. A
  failed call is not memoized. Distinct queries do not bleed into each other.
- **Broad queries do not walk pages.** `999` matches 33 records; the resolver fetches one page and
  ranks client-side, asserted by counting requests carrying a `page` parameter.
- **No lyric text anywhere.** The 145-record fixture corpus was captured with `lyrics` and
  `synced_lyrics` stripped, asserted per record. Separately, a record *with* lyrics is pushed
  through `normalizeSong` and through the `song` command, and the output is scanned for the canary
  string. Both the data and the code path are covered.
- **Contract drift.** `npm run probe` passes every check against the live archive.

## Exit gate

| Requirement | Status |
|---|---|
| Named acceptance queries resolve correctly | pass (after D-1, D-2) |
| No `undefined`/`NaN` in any embed | pass |
| Resolution critic: zero critical, zero major | pass — D-1 and D-2 found and fixed |
| Live integration tests green | pass |
| `npm run verify` green | pass — 207 tests |

**Milestone 2 exits.** Remaining defects D-3, D-4, D-5 are minor and recorded in
`docs/known-issues.md`.
