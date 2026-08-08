import { createCache } from "./cache.js";
import { isPlayablePath, normalizePath, normalizeSong, normalizeSongPage, normalizeStats } from "./normalize.js";
import { SCORES, rankSongs, resolveRanking } from "./search.js";

/**
 * The archive service commands actually talk to: HTTP + normalize + cache +
 * ranking, behind intent-shaped methods.
 *
 * Commands never see a raw archive record, never build a URL, and never decide
 * what "close enough" means. They ask for a resolution and render the answer.
 */

const SEARCH_PAGE_SIZE = 25;

/** One page is fetched per query, never many. A 200-result term must not walk 200 pages. */
const SEARCH_TTL_MS = 300_000;
const SONG_TTL_MS = 900_000;
const STATS_TTL_MS = 300_000;

/**
 * How good a text match has to be to outrank treating a numeric query as an id.
 * Exact-alias level: only a track genuinely *called* "999" beats song id 999.
 */
const TITLE_MATCH_BEATS_ID = SCORES.exactAlias;

function looksLikeId(query) {
    return /^\d{1,9}$/.test(query.trim());
}

function looksLikePath(query) {
    const trimmed = query.trim();
    return trimmed.includes("/") && isPlayablePath(trimmed);
}

/** A path the user supplied directly is enough to build a playable Song from. */
function songFromPath(rawPath, { apiBase }) {
    const safe = normalizePath(rawPath);
    const base = safe.split("/").pop() ?? safe;
    const title = base.replace(/\.[^.]+$/, "");
    return normalizeSong({ name: title, path: safe, track_titles: [title] }, { apiBase });
}

export function createArchiveService({ api, config, clock = Date, logger = null }) {
    const options = { apiBase: config.apiBaseUrl };

    const searchCache = createCache({ ttlMs: SEARCH_TTL_MS, maxEntries: 300, clock });
    const songCache = createCache({ ttlMs: SONG_TTL_MS, maxEntries: 500, clock });
    const statsCache = createCache({ ttlMs: STATS_TTL_MS, maxEntries: 4, clock });

    async function songById(id) {
        return songCache.wrap(`song:${id}`, async () => {
            const record = await api.song(id);
            return normalizeSong(record, options);
        });
    }

    /** One archive page per distinct query, cached for five minutes. */
    async function searchRaw(query) {
        const key = `q:${query.trim().toLowerCase()}`;
        return searchCache.wrap(key, async () => {
            const page = await api.songs({
                searchall: query,
                page_size: SEARCH_PAGE_SIZE,
                file_names_array: true,
            });
            return normalizeSongPage(page, options);
        });
    }

    return {
        songById,

        async stats() {
            return statsCache.wrap("stats", async () => normalizeStats(await api.stats()));
        },

        async health() {
            return api.health();
        },

        /** Ranked candidates for a query, highest score first. */
        async search(query, { limit = 10 } = {}) {
            const page = await searchRaw(query);
            return {
                totalCount: page.count,
                results: rankSongs(page.songs, query, { limit }),
            };
        },

        /**
         * The resolution pipeline.
         *
         * @returns {{kind:"one",song}|{kind:"many",candidates}|{kind:"none",query,totalSongs}}
         */
        async resolve(query) {
            const trimmed = String(query ?? "").trim();
            if (!trimmed) return { kind: "none", query: trimmed, totalSongs: null };

            // 1. A full archive path can be used as-is.
            if (looksLikePath(trimmed)) {
                const song = songFromPath(trimmed, options);
                if (song.streamUrl) return { kind: "one", song, score: Infinity };
            }

            // 2. A bare integer is *probably* an id — but plenty of tracks are
            //    named with digits, and this archive has a song literally called
            //    "999". Taking the id blindly made `play 999` resolve to song id
            //    999 ("Fine China"), which is not what anyone meant. So both are
            //    tried, and a real title match wins over the id.
            if (looksLikeId(trimmed)) {
                const [byId, byText] = await Promise.allSettled([songById(trimmed), searchRaw(trimmed)]);

                if (byText.status === "fulfilled") {
                    const ranked = rankSongs(byText.value.songs, trimmed, { limit: SEARCH_PAGE_SIZE });
                    if (ranked[0]?.score >= TITLE_MATCH_BEATS_ID) {
                        return resolveRanking(ranked);
                    }
                }
                if (byId.status === "fulfilled" && byId.value?.streamUrl) {
                    return { kind: "one", song: byId.value, score: Infinity };
                }
                logger?.debug("id lookup missed, falling back to text", {
                    query: trimmed,
                    status: byId.reason?.status,
                });
            }

            // 3. Otherwise: one search page, ranked.
            const page = await searchRaw(trimmed);
            const ranked = rankSongs(page.songs, trimmed, { limit: SEARCH_PAGE_SIZE });
            const outcome = resolveRanking(ranked);

            if (outcome.kind === "none") {
                let totalSongs = null;
                try {
                    totalSongs = (await this.stats()).totalSongs;
                } catch {
                    // A missing count only costs a nicer message.
                }
                return { kind: "none", query: trimmed, totalSongs };
            }
            return outcome;
        },

        get cacheStats() {
            return { search: searchCache.stats, song: songCache.stats, stats: statsCache.stats };
        },

        clearCaches() {
            searchCache.clear();
            songCache.clear();
            statsCache.clear();
        },
    };
}
