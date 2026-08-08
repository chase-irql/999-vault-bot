/**
 * Raw archive record -> canonical Song. Pure: no I/O, no clock, no randomness.
 *
 * The canonical shape is built field by field rather than by spreading the raw
 * record. That is deliberate and load-bearing: every archive song record carries
 * `lyrics` and `synced_lyrics` inline, and this project never emits lyric text.
 * Because the canonical shape has no lyric field, no embed, log line, or command
 * downstream has anything to render — the exclusion is structural rather than a
 * rule somebody has to remember.
 */

const SITE_ORIGIN = "https://juicewrldapi.com";

const CATEGORIES = new Set(["released", "unreleased", "unsurfaced", "recording_session"]);

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".flac"]);

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Collapses control characters and whitespace; archive text contains raw CRLF. */
export function cleanText(value, { fallback = "", max = 1_000 } = {}) {
    if (typeof value !== "string") return fallback;
    const cleaned = value
        .normalize("NFKC")
        .replace(/[\0\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned ? cleaned.slice(0, max) : fallback;
}

function positiveId(value) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * `length` is a "m:ss" (or "h:mm:ss") string and is empty on roughly a third of
 * records. Anything unparseable returns null, which renders as `--:--`. It must
 * never return NaN and must never guess.
 */
export function parseDuration(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) && value >= 0 && value <= 86_400 ? Math.round(value) : null;
    }
    if (typeof value !== "string") return null;
    const input = value.trim();
    if (!input) return null;

    if (/^\d+(?:\.\d+)?$/.test(input)) {
        const seconds = Number(input);
        return Number.isFinite(seconds) && seconds <= 86_400 ? Math.round(seconds) : null;
    }

    const parts = input.split(":");
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts.every((part) => /^\d{1,3}$/.test(part))) return null;

    const numbers = parts.map(Number);
    const seconds = numbers.at(-1);
    const minutes = numbers.at(-2);
    const hours = numbers.length === 3 ? numbers[0] : 0;
    if (seconds > 59) return null;
    if (numbers.length === 3 && minutes > 59) return null;

    const total = hours * 3_600 + minutes * 60 + seconds;
    return total <= 86_400 ? total : null;
}

/** Rejects traversal, absolute paths, and control characters before the path is used in a URL. */
export function normalizePath(value) {
    if (typeof value !== "string") return "";
    const normalized = value.normalize("NFKC").replaceAll("\\", "/").trim();
    if (!normalized || normalized.length > 4_096) return "";
    if (/[\0\r\n]/.test(normalized) || normalized.startsWith("/")) return "";
    if (normalized.split("/").some((part) => !part || part === "." || part === "..")) return "";
    return normalized;
}

export function isPlayablePath(value) {
    const normalized = normalizePath(value);
    if (!normalized) return false;
    const dot = normalized.lastIndexOf(".");
    if (dot === -1) return false;
    return AUDIO_EXTENSIONS.has(normalized.slice(dot).toLowerCase());
}

/**
 * `image_url` is site-relative in practice (`/assets/999.jpg`), not the absolute
 * URL the contract example suggests. Anything that does not resolve to https on
 * the expected origin returns "" so an embed shows no thumbnail rather than a
 * broken one.
 */
export function resolveImageUrl(value, siteOrigin = SITE_ORIGIN) {
    if (typeof value !== "string" || !value.trim() || value.length > 2_048) return "";
    const raw = value.trim();
    if (raw.startsWith("//")) return "";
    try {
        const origin = new URL(siteOrigin);
        const url = new URL(raw, `${origin.origin}/`);
        if (url.protocol !== "https:" || url.origin !== origin.origin) return "";
        if (url.username || url.password) return "";
        return url.toString();
    } catch {
        return "";
    }
}

export function buildStreamUrl(songPath, apiBase) {
    const safe = normalizePath(songPath);
    if (!safe) return "";
    try {
        const base = new URL(apiBase);
        if (base.protocol !== "https:" || base.username || base.password) return "";
        const url = new URL(`${base.toString().replace(/\/$/, "")}/files/download/`);
        url.searchParams.set("path", safe);
        return url.toString();
    } catch {
        return "";
    }
}

export function normalizeEra(raw) {
    if (!isPlainObject(raw)) return null;
    const id = positiveId(raw.id);
    const name = cleanText(raw.name, { max: 120 });
    if (!name) return null;
    const playCount = Number(raw.play_count ?? raw.playCount);
    return {
        id,
        name,
        timeFrame: cleanText(raw.time_frame ?? raw.timeFrame, { max: 200 }),
        playCount: Number.isSafeInteger(playCount) && playCount >= 0 ? playCount : 0,
    };
}

/**
 * The first `track_titles` entry is the archive's canonical title; the rest,
 * plus `name`, become aliases. Matching the desktop client here matters — a
 * different title choice would make the same query resolve differently in the
 * two apps.
 */
function titleAndAliases(raw) {
    const trackTitles = Array.isArray(raw.track_titles) ? raw.track_titles : [];
    const cleanedTitles = trackTitles.map((item) => cleanText(item, { max: 300 })).filter(Boolean);
    const name = cleanText(raw.name, { max: 300 });
    const title = cleanedTitles[0] || name || "Unknown track";

    const seen = new Set([title.toLowerCase()]);
    const aliases = [];
    for (const candidate of [...cleanedTitles.slice(1), name]) {
        const key = candidate.toLowerCase();
        if (!candidate || seen.has(key)) continue;
        seen.add(key);
        aliases.push(candidate);
        if (aliases.length === 50) break;
    }
    return { title, aliases };
}

/**
 * @param {object} raw archive song record
 * @param {{ apiBase: string, siteOrigin?: string }} options
 */
export function normalizeSong(raw, { apiBase, siteOrigin = SITE_ORIGIN } = {}) {
    const record = isPlainObject(raw) ? raw : {};
    const { title, aliases } = titleAndAliases(record);
    const songPath = normalizePath(record.path);
    const fileNames = (Array.isArray(record.file_names) ? record.file_names : [])
        .map((item) => cleanText(item, { max: 300 }))
        .filter(Boolean)
        .slice(0, 25);

    return {
        id: positiveId(record.id),
        publicId: positiveId(record.public_id),
        title,
        aliases,
        fileNames,
        path: songPath,
        artist: cleanText(record.credited_artists, { fallback: "Juice WRLD", max: 300 }),
        album: cleanText(record.album, { max: 300 }),
        durationSeconds: parseDuration(record.length),
        category: CATEGORIES.has(record.category) ? record.category : "unknown",
        era: normalizeEra(record.era),
        imageUrl: resolveImageUrl(record.image_url, siteOrigin),
        streamUrl: buildStreamUrl(songPath, apiBase),
        producers: cleanText(record.producers, { max: 500 }),
        engineers: cleanText(record.engineers, { max: 500 }),
        recordingLocations: cleanText(record.recording_locations, { max: 500 }),
        leakType: cleanText(record.leak_type, { max: 200 }),
        // No `lyrics`. No `synced_lyrics`. See the module comment.
    };
}

export function normalizeSongPage(raw, options) {
    const results = Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
    const count = Number(raw?.count);
    return {
        count: Number.isSafeInteger(count) && count >= 0 ? count : results.length,
        hasNext: Boolean(raw?.next),
        songs: results.map((record) => normalizeSong(record, options)),
    };
}

export function normalizeStats(raw) {
    const record = isPlainObject(raw) ? raw : {};
    const total = Number(record.total_songs);
    return {
        totalSongs: Number.isSafeInteger(total) && total >= 0 ? total : null,
        categoryStats: isPlainObject(record.category_stats) ? record.category_stats : {},
        eraStats: isPlainObject(record.era_stats) ? record.era_stats : {},
    };
}

export { AUDIO_EXTENSIONS, CATEGORIES, SITE_ORIGIN };
