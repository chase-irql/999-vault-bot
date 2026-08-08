import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ArchiveApi } from "../src/api/client.js";

/**
 * Captures real song records from the live archive into test/fixtures/songs.json
 * so the search-scoring suite runs offline against data that actually exists.
 *
 * Lyrics are stripped on the way in. The archive returns `lyrics` and
 * `synced_lyrics` inline on every record; this project never emits lyric text,
 * and the cleanest way to guarantee that is for none to be in the repository at
 * all — not in a fixture, not in a test snapshot.
 *
 * Usage: node scripts/capture-fixtures.mjs
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Queries chosen to cover the ambiguous cases the resolver has to get right. */
const QUERIES = [
    "lucid dreams",
    "armed and dangerous",
    "bad day",
    "999",
    "all girls are the same",
    "legends",
    "robbery",
    "righteous",
    "come and go",
    "wishing well",
    "empty",
    "hear me calling",
    "black and white",
    "candles",
    "sometimes",
];

const STRIP = new Set(["lyrics", "synced_lyrics"]);

function withoutLyrics(record) {
    const output = {};
    for (const [key, value] of Object.entries(record)) {
        if (STRIP.has(key)) continue;
        output[key] = value;
    }
    return output;
}

const api = new ArchiveApi({ baseUrl: "https://juicewrldapi.com/juicewrld" });

const byId = new Map();
for (const query of QUERIES) {
    const page = await api.songs({ searchall: query, page_size: 10, file_names_array: true });
    for (const record of page.results ?? []) {
        if (!byId.has(record.id)) byId.set(record.id, withoutLyrics(record));
    }
    process.stdout.write(`  ${query.padEnd(24)} ${page.count} matches\n`);
}

// A page of unfiltered records, so the fixtures include the empty-length and
// empty-path cases that a third of the archive has.
const bulk = await api.songs({ page_size: 60, page: 3, file_names_array: true });
for (const record of bulk.results ?? []) {
    if (!byId.has(record.id)) byId.set(record.id, withoutLyrics(record));
}

const songs = [...byId.values()].sort((a, b) => a.id - b.id);

const stats = await api.stats();

await mkdir(path.join(root, "test", "fixtures"), { recursive: true });
await writeFile(
    path.join(root, "test", "fixtures", "songs.json"),
    `${JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), count: songs.length, songs }, null, 1)}\n`
);
await writeFile(
    path.join(root, "test", "fixtures", "stats.json"),
    `${JSON.stringify(stats, null, 1)}\n`
);

const radio = await api.radioLive();
await writeFile(path.join(root, "test", "fixtures", "radio-live.json"), `${JSON.stringify(radio, null, 1)}\n`);

const noPath = songs.filter((song) => !song.path).length;
const noLength = songs.filter((song) => !song.length).length;
process.stdout.write(
    `\ncaptured ${songs.length} songs (${noPath} without a path, ${noLength} without a length), ` +
        `stats, and one radio snapshot\n`
);
if (songs.some((song) => "lyrics" in song || "synced_lyrics" in song)) {
    process.stderr.write("refusing to write: lyric fields survived the strip\n");
    process.exit(1);
}
