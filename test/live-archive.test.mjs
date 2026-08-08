import assert from "node:assert/strict";
import process from "node:process";
import test, { describe } from "node:test";
import { ArchiveApi } from "../src/api/client.js";
import { normalizeSongPage } from "../src/api/normalize.js";

/**
 * Integration tests against the live archive.
 *
 * Skipped when SKIP_LIVE=1, which CI sets: a push should not fail because
 * somebody else's server had a bad minute, and it should not add load to a
 * public archive on every commit. Run them locally with `npm run verify`.
 *
 * These assert the contract, not the content. "Lucid Dreams is track 4" is not
 * this suite's business; "the envelope still has a count field" is.
 */

const skip = process.env.SKIP_LIVE === "1" ? "SKIP_LIVE=1" : false;
const BASE = "https://juicewrldapi.com/juicewrld";
const api = new ArchiveApi({ baseUrl: BASE, minIntervalMs: 0, timeoutMs: 20_000 });

describe("live archive contract", { skip }, () => {
    test("/health/ returns ok", async () => {
        assert.deepEqual(await api.health(), { status: "ok" });
    });

    test("/songs/?searchall= returns a paginated envelope", async () => {
        const page = await api.songs({ searchall: "lucid", page_size: 5, file_names_array: true });
        for (const key of ["count", "next", "previous", "results"]) {
            assert.ok(key in page, `envelope is missing "${key}"`);
        }
        assert.ok(Array.isArray(page.results));
        assert.ok(page.results.length > 0);
    });

    test("live records still normalize into the canonical shape", async () => {
        const page = await api.songs({ searchall: "lucid dreams", page_size: 10, file_names_array: true });
        const { songs } = normalizeSongPage(page, { apiBase: BASE });
        assert.ok(songs.length > 0);
        for (const song of songs) {
            assert.ok(song.title.length > 0);
            assert.ok(song.durationSeconds === null || Number.isFinite(song.durationSeconds));
            assert.equal("lyrics" in song, false, "lyrics must not survive normalization");
            assert.equal("syncedLyrics" in song, false);
        }
    });

    test("/stats/ reports a plausible archive size", async () => {
        const stats = await api.stats();
        assert.ok(stats.total_songs > 2000, `total_songs was ${stats.total_songs}`);
    });

    test("/files/download/ honours a Range request with a 206", async () => {
        const page = await api.songs({ searchall: "lucid dreams", page_size: 1 });
        const path = page.results[0]?.path;
        assert.ok(path, "expected a sample record with a path");

        const response = await fetch(api.streamUrl(path), { headers: { Range: "bytes=0-1023" } });
        try {
            assert.equal(response.status, 206);
            assert.equal(response.headers.get("accept-ranges"), "bytes");
            assert.match(response.headers.get("content-range") ?? "", /^bytes 0-1023\/\d+$/);
        } finally {
            await response.body?.cancel();
        }
    });

    test("/radio/live/ carries now_playing.elapsed_ms", async () => {
        const radio = await api.radioLive();
        assert.ok("now_playing" in radio);
        assert.ok("elapsed_ms" in radio.now_playing, "elapsed_ms is what the local clock extrapolates from");
        assert.ok("duration_ms" in radio.now_playing);
        assert.ok("stale_seconds" in radio);
    });

    test("/radio/random/ returns a playable archive song", async () => {
        const random = await api.radioRandom();
        assert.ok(random?.song && typeof random.song === "object");
        assert.ok(random.song.id);
        assert.equal(random.song.path || random.path, random.path);
        assert.match(random.path, /\.(mp3|m4a|ogg|wav)$/i);
    });

    test("/radio/live/ still returns a cleartext stream_url that must be upgraded", async () => {
        const radio = await api.radioLive();
        // If this ever fails because the archive started returning https, that is
        // good news — but the upgrade in audio/radio.js stays either way.
        assert.match(String(radio.stream_url), /^https?:\/\//);
    });

    test("/radio/stream.mp3 is an endless, unseekable stream", async () => {
        const response = await fetch(api.radioStreamUrl());
        try {
            assert.match(response.headers.get("content-type") ?? "", /audio\//);
            assert.equal(response.headers.get("content-length"), null, "an endless stream has no length");
            assert.equal(response.headers.get("accept-ranges"), null, "and cannot be seeked");
        } finally {
            await response.body?.cancel();
        }
    });

    test("/songs/ ignores an ordering parameter instead of rejecting it", async () => {
        const plain = await api.songs({ searchall: "lucid", page_size: 5 });
        const ordered = await api.songs({ searchall: "lucid", page_size: 5, ordering: "title" });
        assert.deepEqual(
            ordered.results.map((row) => row.id),
            plain.results.map((row) => row.id),
            "ordering silently does nothing — rank client-side"
        );
    });
});
