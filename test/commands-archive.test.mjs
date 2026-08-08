import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { ArchiveApi } from "../src/api/client.js";
import { normalizeSong } from "../src/api/normalize.js";
import { createArchiveService } from "../src/api/resolve.js";
import { createRegistry } from "../src/bot/commands/index.js";
import { UserError } from "../src/core/errors.js";
import { createContext, embedText, fakeClock, lastEmbed, testConfig } from "./helpers/context.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(await readFile(path.join(root, "test/fixtures/songs.json"), "utf8"));
const statsFixture = JSON.parse(await readFile(path.join(root, "test/fixtures/stats.json"), "utf8"));

const registry = createRegistry();
const config = testConfig();

/**
 * A fake fetch serving the captured fixtures. This exercises the real
 * ArchiveApi, the real cache, the real normalizer, and the real scorer — the
 * whole path a command takes, with only the socket replaced.
 */
function fixtureFetch({ onRequest } = {}) {
    let calls = 0;
    const impl = async (url) => {
        calls += 1;
        const target = new URL(url);
        onRequest?.(target);

        const json = (body, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

        if (target.pathname.endsWith("/stats/")) return json(statsFixture);
        if (target.pathname.endsWith("/health/")) return json({ status: "ok" });

        const songMatch = target.pathname.match(/\/songs\/(\d+)\/$/);
        if (songMatch) {
            const record = fixtures.songs.find((song) => String(song.id) === songMatch[1]);
            return record ? json(record) : json({ detail: "Not found." }, 404);
        }

        if (target.pathname.endsWith("/songs/")) {
            const query = (target.searchParams.get("searchall") ?? "").toLowerCase();
            const results = fixtures.songs.filter((song) => {
                const haystack = [song.name, ...(song.track_titles ?? [])].join(" ").toLowerCase();
                return query.split(/\s+/).every((token) => haystack.includes(token));
            });
            return json({ count: results.length, next: null, previous: null, results: results.slice(0, 25) });
        }
        return json({ detail: "Unhandled" }, 404);
    };
    return {
        impl,
        get calls() {
            return calls;
        },
    };
}

function archiveDeps({ onRequest } = {}) {
    const fetcher = fixtureFetch({ onRequest });
    const api = new ArchiveApi({
        baseUrl: config.apiBaseUrl,
        fetchImpl: fetcher.impl,
        minIntervalMs: 0,
    });
    const archive = createArchiveService({ api, config, clock: fakeClock() });
    return { archive, api, fetcher };
}

const run = (name, options) => registry.find(name).execute(createContext({ commandName: name, ...options }));

describe("search", () => {
    test("lists ranked results with a play invocation for each", async () => {
        const { archive } = archiveDeps();
        const ctx = createContext({ commandName: "search", rest: "lucid dreams", deps: { archive } });
        await registry.find("search").execute(ctx);

        const embed = lastEmbed(ctx);
        const text = embedText(embed);
        assert.ok(text.includes("Lucid Dreams"));
        assert.ok(text.includes("jw!play "), "each result must carry its exact play invocation");
        assert.ok(ctx.deferred, "an archive round trip must defer first");
    });

    test("reports no results with the term and a suggestion, not a bare not-found", async () => {
        const { archive } = archiveDeps();
        const ctx = createContext({
            commandName: "search",
            rest: "zzzz definitely not a song zzzz",
            deps: { archive },
        });
        await registry.find("search").execute(ctx);

        const text = embedText(lastEmbed(ctx));
        assert.ok(text.includes("zzzz definitely not a song zzzz"));
        assert.ok(text.includes("jw!search"), "should offer a next step");
        assert.ok(/\d{4}/.test(text), "should state the archive size");
    });

    test("rejects an empty query with a usable example", async () => {
        const { archive } = archiveDeps();
        await assert.rejects(() => run("search", { rest: "", deps: { archive } }), (error) => {
            assert.ok(error instanceof UserError);
            assert.match(error.userMessage, /jw!search lucid dreams/);
            return true;
        });
    });

    test("never offers a result that cannot be played", async () => {
        const { archive } = archiveDeps();
        for (const query of ["lucid", "999", "robbery"]) {
            const { results } = await archive.search(query, { limit: 25 });
            for (const entry of results) {
                assert.ok(entry.song.streamUrl, `${query}: offered ${entry.song.id} with no stream URL`);
            }
        }
    });
});

describe("song", () => {
    test("shows metadata for a confident match", async () => {
        const { archive } = archiveDeps();
        const ctx = createContext({ commandName: "song", rest: "wishing well", deps: { archive } });
        await registry.find("song").execute(ctx);

        const embed = lastEmbed(ctx);
        assert.equal(embed.author.name, "Archive entry");
        assert.ok(embed.footer.text.includes("JuiceWRLDAPI.com"), "the archive must be credited");
    });

    test("resolves a bare id directly", async () => {
        const seen = [];
        const { archive } = archiveDeps({ onRequest: (url) => seen.push(url.pathname) });
        const ctx = createContext({ commandName: "song", rest: "94034", deps: { archive } });
        await registry.find("song").execute(ctx);

        assert.ok(seen.some((p) => p.endsWith("/songs/94034/")), "an integer should hit the by-id route");
        // Parentheses are not Discord markdown, so they are deliberately not escaped.
        assert.equal(lastEmbed(ctx).title, "lucid dreams (forget me)");
    });

    test("lists options when the query is genuinely ambiguous", async () => {
        const { archive } = archiveDeps();
        const ctx = createContext({ commandName: "song", rest: "bad day", deps: { archive } });
        await registry.find("song").execute(ctx);

        const embed = lastEmbed(ctx);
        assert.equal(embed.author.name, "Which one?");
        assert.ok(embed.description.includes("Bad Day"));
    });

    test("never emits lyric text even though the archive returns it", async () => {
        // The fixture corpus is captured without lyrics, so this asserts the
        // second half: a raw record carrying lyrics still cannot reach an embed.
        const withLyrics = { ...fixtures.songs.find((s) => s.id === 94034), lyrics: "LYRIC-CANARY" };
        const song = normalizeSong(withLyrics, { apiBase: config.apiBaseUrl });
        const archive = { resolve: async () => ({ kind: "one", song }), stats: async () => ({ totalSongs: 1 }) };

        const ctx = createContext({ commandName: "song", rest: "lucid dreams", deps: { archive } });
        await registry.find("song").execute(ctx);
        assert.ok(!embedText(lastEmbed(ctx)).includes("LYRIC-CANARY"));
    });

    test("rejects an empty query", async () => {
        const { archive } = archiveDeps();
        await assert.rejects(() => run("song", { rest: "", deps: { archive } }), UserError);
    });
});

describe("stats", () => {
    test("reports archive totals alongside bot state", async () => {
        const { archive } = archiveDeps();
        const ctx = createContext({
            commandName: "stats",
            deps: { archive, players: { size: 2, radioCount: 1 }, guildCount: () => 3 },
        });
        await registry.find("stats").execute(ctx);

        const text = embedText(lastEmbed(ctx));
        assert.ok(text.includes(String(statsFixture.total_songs)));
        assert.ok(text.includes("Active players"));
    });

    test("works before any player exists", async () => {
        const { archive } = archiveDeps();
        const ctx = createContext({ commandName: "stats", deps: { archive } });
        await registry.find("stats").execute(ctx);
        const fields = lastEmbed(ctx).fields;
        assert.equal(fields.find((field) => field.name === "Active players").value, "0");
    });
});

describe("archive service caching", () => {
    test("the same query twice inside the TTL issues exactly one HTTP request", async () => {
        const requests = [];
        const { archive } = archiveDeps({ onRequest: (url) => requests.push(url.searchParams.get("searchall")) });

        await archive.search("lucid dreams");
        await archive.search("lucid dreams");
        await archive.search("LUCID DREAMS");

        const searches = requests.filter((value) => value !== null);
        assert.equal(searches.length, 1, `expected one archive call, got ${searches.length}`);
    });

    test("a different query is a separate request", async () => {
        const requests = [];
        const { archive } = archiveDeps({ onRequest: (url) => requests.push(url.searchParams.get("searchall")) });
        await archive.search("lucid dreams");
        await archive.search("robbery");
        assert.equal(requests.filter(Boolean).length, 2);
    });

    test("a broad query fetches one page, not many", async () => {
        const requests = [];
        const { archive } = archiveDeps({ onRequest: (url) => requests.push(url.searchParams.get("page"))});
        await archive.search("999", { limit: 25 });
        assert.equal(requests.filter(Boolean).length, 0, "no pagination walk");
    });

    test("results do not bleed between queries", async () => {
        const { archive } = archiveDeps();
        const lucid = await archive.search("lucid dreams");
        const robbery = await archive.search("robbery");
        const lucidIds = new Set(lucid.results.map((entry) => entry.song.id));
        assert.ok(
            robbery.results.every((entry) => !lucidIds.has(entry.song.id)),
            "one query's cached results must never surface under another"
        );
    });

    test("a numeric query that is also a real title prefers the title over the id", async () => {
        // Regression: `play 999` resolved to song id 999 ("Fine China") rather
        // than the track actually called "999". Both lookups now run and a real
        // title match wins.
        const titled999 = {
            id: 94412,
            public_id: 1,
            name: "999",
            track_titles: ["999"],
            category: "unreleased",
            era: { id: 1, name: "GB&GR", play_count: 117343 },
            path: "Compilation/999.mp3",
            length: "2:30",
            credited_artists: "Juice WRLD",
        };
        const decoy = { ...titled999, id: 999, name: "Fine China", track_titles: ["Fine China"] };

        const fetchImpl = async (url) => {
            const target = new URL(url);
            const json = (body) =>
                new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
            if (target.pathname.endsWith("/songs/999/")) return json(decoy);
            if (target.pathname.endsWith("/songs/")) {
                return json({ count: 1, next: null, previous: null, results: [titled999] });
            }
            return json({});
        };

        const api = new ArchiveApi({ baseUrl: config.apiBaseUrl, fetchImpl, minIntervalMs: 0 });
        const archive = createArchiveService({ api, config, clock: fakeClock() });

        const outcome = await archive.resolve("999");
        assert.equal(outcome.kind, "one");
        assert.equal(outcome.song.title, "999");
        assert.equal(outcome.song.id, 94412, "must not be the id-999 decoy");
    });

    test("a numeric query with no title match still resolves by id", async () => {
        const seen = [];
        const { archive } = archiveDeps({ onRequest: (url) => seen.push(url.pathname) });
        const outcome = await archive.resolve("94034");
        assert.equal(outcome.kind, "one");
        assert.equal(outcome.song.id, 94034);
        assert.ok(seen.some((p) => p.endsWith("/songs/94034/")));
    });

    test("resolve falls back to a text search when an id lookup misses", async () => {
        const seen = [];
        const { archive } = archiveDeps({ onRequest: (url) => seen.push(url.pathname + url.search) });
        const outcome = await archive.resolve("99999999");
        assert.ok(seen.some((entry) => entry.includes("/songs/99999999/")), "tries the id first");
        assert.ok(seen.some((entry) => entry.includes("searchall=")), "then falls back to searching");
        assert.equal(outcome.kind, "none");
    });
});

describe("random archive tracks", () => {
    test("uses the playable radio endpoint and normalizes nested song payloads", async () => {
        const seen = [];
        let cursor = 0;
        const api = new ArchiveApi({
            baseUrl: config.apiBaseUrl,
            minIntervalMs: 0,
            fetchImpl: async (url) => {
                seen.push(new URL(url).pathname);
                const record = fixtures.songs[cursor++ % fixtures.songs.length];
                return new Response(JSON.stringify({ path: record.path, song: record }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            },
        });
        const archive = createArchiveService({ api, config, clock: fakeClock() });

        const songs = await archive.randomSongs(3);

        assert.equal(seen.length, 3);
        assert.ok(seen.every((path) => path.endsWith("/radio/random/")));
        assert.equal(songs.length, 3);
        assert.ok(songs.every((entry) => entry.streamUrl && entry.path));
    });

    test("filters duplicates, recent ids, failures, and unplayable responses", async () => {
        const playable = fixtures.songs[0];
        const duplicate = { ...playable };
        const excluded = fixtures.songs[1];
        const unplayable = { ...fixtures.songs.find((entry) => !entry.path) };
        const outcomes = [playable, duplicate, excluded, unplayable];
        let cursor = 0;
        const api = {
            async radioRandom() {
                const value = outcomes[cursor++];
                if (cursor === outcomes.length) throw new Error("temporary outage");
                return { path: value.path, song: value };
            },
        };
        const archive = createArchiveService({ api, config, clock: fakeClock() });

        const songs = await archive.randomSongs(5, { exclude: new Set([excluded.id]) });

        assert.deepEqual(songs.map((entry) => entry.id), [playable.id]);
    });
});
