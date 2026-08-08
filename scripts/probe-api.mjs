import process from "node:process";
import { ArchiveApi } from "../src/api/client.js";

/**
 * Contract probe. Hits every endpoint the bot uses, prints a shape summary, and
 * exits non-zero on drift.
 *
 * Run this before writing code against any archive endpoint. The contract in
 * CLAUDE.md was verified on a specific date; this is how you find out it has
 * changed before a user does.
 *
 * Usage: npm run probe
 */

const BASE = process.env.API_BASE_URL || "https://juicewrldapi.com/juicewrld";
const api = new ArchiveApi({ baseUrl: BASE, minIntervalMs: 0 });

const failures = [];
const notes = [];

function check(label, condition, detail = "") {
    const mark = condition ? "ok  " : "DRIFT";
    process.stdout.write(`  ${mark}  ${label}${detail ? ` — ${detail}` : ""}\n`);
    if (!condition) failures.push(label);
    return condition;
}

function section(name) {
    process.stdout.write(`\n${name}\n`);
}

process.stdout.write(`probing ${BASE}\n`);

// --- /health/ --------------------------------------------------------------
section("GET /health/");
try {
    const health = await api.health();
    check("returns status ok", health?.status === "ok", JSON.stringify(health));
} catch (error) {
    check("reachable", false, error.message);
}

// --- /songs/ ---------------------------------------------------------------
section("GET /songs/");
let sample = null;
try {
    const page = await api.songs({ searchall: "lucid dreams", page_size: 5, file_names_array: true });
    check("paginated envelope", ["count", "next", "previous", "results"].every((key) => key in page));
    check("results is an array", Array.isArray(page.results), `${page.results?.length} rows`);

    sample = page.results?.[0];
    if (sample) {
        const required = [
            "id",
            "public_id",
            "name",
            "category",
            "era",
            "path",
            "track_titles",
            "credited_artists",
            "producers",
            "engineers",
            "recording_locations",
            "length",
            "album",
            "image_url",
            "leak_type",
        ];
        for (const field of required) check(`song.${field} present`, field in sample);
        check("length is a string, not seconds", typeof sample.length === "string", JSON.stringify(sample.length));
        check("era carries name and play_count", Boolean(sample.era?.name) && "play_count" in sample.era);

        // Documented in ADR 0004: lyrics ship inline on every record. The bot
        // must never emit them; this only confirms the field is still there so
        // the exclusion stays deliberate rather than accidental.
        if ("lyrics" in sample) {
            notes.push("song records still carry `lyrics` inline — normalize.js must keep dropping it");
        }
        check("image_url is site-relative as expected", String(sample.image_url ?? "").startsWith("/"),
            JSON.stringify(sample.image_url));
    }
} catch (error) {
    check("reachable", false, error.message);
}

// --- ordering is ignored ---------------------------------------------------
section("GET /songs/?ordering=… (expected to be silently ignored)");
try {
    const plain = await api.songs({ searchall: "lucid", page_size: 5 });
    const ordered = await api.songs({ searchall: "lucid", page_size: 5, ordering: "title" });
    const same = JSON.stringify(plain.results?.map((r) => r.id)) === JSON.stringify(ordered.results?.map((r) => r.id));
    check("ordering does not change the result order", same, "sort client-side");
} catch (error) {
    check("reachable", false, error.message);
}

// --- /songs/{id}/ ----------------------------------------------------------
section("GET /songs/{id}/");
try {
    const one = await api.song(94034);
    check("returns a single record", one?.id === 94034, one?.name);
} catch (error) {
    check("reachable", false, error.message);
}

// --- /stats/ ---------------------------------------------------------------
section("GET /stats/");
try {
    const stats = await api.stats();
    check("total_songs is a number", Number.isFinite(stats?.total_songs), String(stats?.total_songs));
    check("category_stats present", Boolean(stats?.category_stats));
    check("era_stats present", Boolean(stats?.era_stats));
} catch (error) {
    check("reachable", false, error.message);
}

// --- /eras/ and /categories/ ----------------------------------------------
section("GET /eras/ and /categories/");
try {
    const eras = await api.eras({ page_size: 3 });
    check("eras paginated", Array.isArray(eras?.results), `${eras?.count} eras`);
    const categories = await api.categories();
    const values = (categories?.categories ?? []).map((entry) => entry.value).sort();
    check(
        "categories are the four documented values",
        JSON.stringify(values) === JSON.stringify(["recording_session", "released", "unreleased", "unsurfaced"]),
        values.join(", ")
    );
} catch (error) {
    check("reachable", false, error.message);
}

// --- /files/download/ Range ------------------------------------------------
section("GET /files/download/ (Range support)");
try {
    const path = sample?.path;
    if (!path) throw new Error("no sample path to test with");
    const response = await fetch(api.streamUrl(path), { headers: { Range: "bytes=0-1023" } });
    check("honours Range with 206", response.status === 206, `status ${response.status}`);
    check("advertises byte ranges", response.headers.get("accept-ranges") === "bytes");
    check("returns audio/mpeg", (response.headers.get("content-type") ?? "").includes("audio/"));
    check("sends a Content-Range", Boolean(response.headers.get("content-range")),
        response.headers.get("content-range") ?? "");
    await response.body?.cancel();
} catch (error) {
    check("reachable", false, error.message);
}

// --- /radio/live/ ----------------------------------------------------------
section("GET /radio/live/");
try {
    const radio = await api.radioLive();
    for (const field of ["station", "state", "now_playing", "up_next", "queue_preview", "is_live", "stream_url"]) {
        check(`radio.${field} present`, field in radio);
    }
    check("now_playing.elapsed_ms present", "elapsed_ms" in (radio.now_playing ?? {}), String(radio.now_playing?.elapsed_ms));
    check("now_playing.duration_ms present", "duration_ms" in (radio.now_playing ?? {}));
    check(
        "stream_url is cleartext and MUST be upgraded to https",
        String(radio.stream_url).startsWith("http://"),
        radio.stream_url
    );
    check("stale_seconds present", "stale_seconds" in radio, String(radio.stale_seconds));
} catch (error) {
    check("reachable", false, error.message);
}

// --- /radio/stream.mp3 -----------------------------------------------------
section("GET /radio/stream.mp3");
try {
    const response = await fetch(api.radioStreamUrl());
    check("streams audio", (response.headers.get("content-type") ?? "").includes("audio/"));
    check("has no Content-Length (endless stream)", response.headers.get("content-length") === null);
    check("does not advertise ranges (unseekable)", response.headers.get("accept-ranges") === null);
    await response.body?.cancel();
} catch (error) {
    check("reachable", false, error.message);
}

// --- data-quality measurements --------------------------------------------
section("Data quality (informational)");
try {
    const bulk = await api.songs({ page_size: 100, page: 3 });
    const rows = bulk.results ?? [];
    const noPath = rows.filter((row) => !row.path).length;
    const noLength = rows.filter((row) => !row.length).length;
    process.stdout.write(`  info   ${noPath}/${rows.length} records have no path (unplayable)\n`);
    process.stdout.write(`  info   ${noLength}/${rows.length} records have no length\n`);
} catch {
    process.stdout.write("  info   sample page unavailable\n");
}

for (const note of notes) process.stdout.write(`\n  note   ${note}\n`);

if (failures.length > 0) {
    process.stdout.write(`\nprobe: ${failures.length} contract check(s) drifted:\n`);
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.stdout.write("\nUpdate docs/decisions/ with an ADR before coding against the new shape.\n");
    process.exit(1);
}

process.stdout.write("\nprobe: the contract in CLAUDE.md still holds\n");
