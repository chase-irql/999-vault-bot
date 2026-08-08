import { isPlayablePath } from "./normalize.js";

/**
 * Scoring and ranking. Pure over a canonical Song list — no I/O, no clock, no
 * randomness — because resolution quality *is* the product, and the only way to
 * iterate on it with confidence is to run it against captured fixtures offline.
 *
 * The archive holds 2500+ entries with alternate titles, working titles, leaked
 * variants and session versions. Playing the wrong "Bad Day" is a failed bot, so
 * the interesting work is in the tie-breakers, not the matches.
 */

export const SCORES = Object.freeze({
    exactTitle: 1000,
    exactAlias: 950,
    exactFileName: 900,
    prefixTitle: 700,
    prefixAlias: 650,
    allTokensTitle: 500,
    allTokensAlias: 450,
    allTokensAlbum: 300,
    substring: 200,
});

/** Confidence thresholds for playing directly instead of asking. */
export const CONFIDENT_SCORE = 900;
export const CONFIDENT_MARGIN = 200;

/** `released` first: when a query is ambiguous the released cut is what a human meant. */
const CATEGORY_RANK = Object.freeze({
    released: 0,
    unreleased: 1,
    recording_session: 2,
    unsurfaced: 3,
    unknown: 4,
});

const LEADING_ARTICLES = /^(?:the|a|an)\s+/;

/**
 * Both sides of every comparison go through this. Punctuation is stripped
 * because the archive is inconsistent about it — "all girls are the same" and
 * "All Girls Are The Same!" must compare equal.
 */
export function normalizeQuery(value) {
    if (typeof value !== "string") return "";
    const base = value
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        // "&" is spelled out before punctuation is stripped. The archive titles
        // this track "Come & Go"; a user types "come and go". Without this the
        // ampersand becomes whitespace and the two never match beyond a weak
        // substring hit.
        .replace(/&/g, " and ")
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    return base.replace(LEADING_ARTICLES, "");
}

export function tokensOf(value) {
    const normalized = normalizeQuery(value);
    return normalized ? normalized.split(" ") : [];
}

function containsAllTokens(haystack, tokens) {
    if (tokens.length === 0) return false;
    return tokens.every((token) => haystack.includes(token));
}

/**
 * Highest single rule wins; rules are not summed. Summing would let three weak
 * partial matches outrank one exact title, which is exactly the failure this
 * scoring exists to prevent.
 */
export function scoreSong(song, query) {
    const needle = normalizeQuery(query);
    if (!needle) return 0;
    const tokens = needle.split(" ");

    const title = normalizeQuery(song.title);
    const aliases = (song.aliases ?? []).map(normalizeQuery).filter(Boolean);
    const fileNames = (song.fileNames ?? []).map(normalizeQuery).filter(Boolean);
    const album = normalizeQuery(song.album);

    if (title === needle) return SCORES.exactTitle;
    if (aliases.includes(needle)) return SCORES.exactAlias;
    if (fileNames.includes(needle)) return SCORES.exactFileName;

    if (title.startsWith(needle)) return SCORES.prefixTitle;
    if (aliases.some((alias) => alias.startsWith(needle))) return SCORES.prefixAlias;

    if (containsAllTokens(title, tokens)) return SCORES.allTokensTitle;
    if (aliases.some((alias) => containsAllTokens(alias, tokens))) return SCORES.allTokensAlias;
    if (album && containsAllTokens(album, tokens)) return SCORES.allTokensAlbum;

    const haystack = [title, ...aliases, ...fileNames, album].join(" | ");
    if (haystack.includes(needle)) return SCORES.substring;

    return 0;
}

/**
 * Deterministic ordering for equal scores. The final `id` comparison exists so
 * the same query always returns the same order — a disambiguation list that
 * reshuffles between two identical searches is its own bug.
 */
export function compareCandidates(a, b) {
    if (b.score !== a.score) return b.score - a.score;

    const categoryDelta =
        (CATEGORY_RANK[a.song.category] ?? CATEGORY_RANK.unknown) -
        (CATEGORY_RANK[b.song.category] ?? CATEGORY_RANK.unknown);
    if (categoryDelta !== 0) return categoryDelta;

    const playDelta = (b.song.era?.playCount ?? 0) - (a.song.era?.playCount ?? 0);
    if (playDelta !== 0) return playDelta;

    const lengthDelta = a.song.title.length - b.song.title.length;
    if (lengthDelta !== 0) return lengthDelta;

    return (a.song.id ?? Number.MAX_SAFE_INTEGER) - (b.song.id ?? Number.MAX_SAFE_INTEGER);
}

/** Songs the bot could not play if it tried. Dropped before scoring, never offered. */
export function isPlayable(song) {
    return Boolean(song?.streamUrl) && isPlayablePath(song?.path);
}

/**
 * @param {object[]} songs canonical Songs
 * @param {string} query free-form user text
 * @param {{ limit?: number }} [options]
 * @returns {{ song: object, score: number }[]} ranked, highest first
 */
export function rankSongs(songs, query, { limit = 25 } = {}) {
    const ranked = [];
    for (const song of songs ?? []) {
        if (!isPlayable(song)) continue;
        const score = scoreSong(song, query);
        if (score <= 0) continue;
        ranked.push({ song, score });
    }
    ranked.sort(compareCandidates);
    return limit > 0 ? ranked.slice(0, limit) : ranked;
}

/**
 * Decides between playing and asking.
 *
 * Confident when the top result is an exact match of some kind (>= 900), or when
 * it is far enough clear of the runner-up that a human would not have hesitated.
 *
 * @returns {{ kind: "none" } | { kind: "one", song: object, score: number }
 *          | { kind: "many", candidates: {song: object, score: number}[] }}
 */
export function resolveRanking(ranked, { choices = 5 } = {}) {
    if (!ranked || ranked.length === 0) return { kind: "none" };

    const [top, runnerUp] = ranked;
    const confident =
        top.score >= CONFIDENT_SCORE || !runnerUp || top.score - runnerUp.score >= CONFIDENT_MARGIN;

    if (confident) return { kind: "one", song: top.song, score: top.score };
    return { kind: "many", candidates: ranked.slice(0, choices) };
}

export { CATEGORY_RANK };
