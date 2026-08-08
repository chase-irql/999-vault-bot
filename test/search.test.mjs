import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeSong } from "../src/api/normalize.js";
import {
    CONFIDENT_MARGIN,
    SCORES,
    compareCandidates,
    isPlayable,
    normalizeQuery,
    rankSongs,
    resolveRanking,
    scoreSong,
    tokensOf,
} from "../src/api/search.js";

/**
 * Scoring is exercised against real records captured from the live archive, not
 * hand-written stubs. Search quality is the product; a stub would let the
 * scoring pass while getting the archive's actual title conventions wrong.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(await readFile(path.join(root, "test/fixtures/songs.json"), "utf8"));
const songs = fixtures.songs.map((raw) => normalizeSong(raw, { apiBase: "https://juicewrldapi.com/juicewrld" }));

const byTitle = (title) => songs.find((song) => song.title === title);
const top = (query, limit = 5) => rankSongs(songs, query, { limit });

describe("fixture corpus", () => {
    test("holds well over the 20 real records the suite needs", () => {
        assert.ok(songs.length >= 20, `only ${songs.length} fixtures`);
    });

    test("includes both playable and unplayable records", () => {
        const playable = songs.filter(isPlayable).length;
        assert.ok(playable > 0 && playable < songs.length, "fixtures must cover both cases");
    });
});

describe("normalizeQuery", () => {
    test("lowercases, strips punctuation, and collapses whitespace", () => {
        assert.equal(normalizeQuery("  All Girls  Are The Same!! "), "all girls are the same");
    });

    test("strips a leading article", () => {
        assert.equal(normalizeQuery("The Bees Knees"), "bees knees");
        assert.equal(normalizeQuery("A Day"), "day");
    });

    test("does not strip an article that is not leading", () => {
        assert.equal(normalizeQuery("me and the crew"), "me and the crew");
    });

    test("spells out an ampersand so & and 'and' compare equal", () => {
        assert.equal(normalizeQuery("Come & Go"), normalizeQuery("come and go"));
        assert.equal(normalizeQuery("Goodbye & Good Riddance"), "goodbye and good riddance");
    });

    test("strips diacritics", () => {
        assert.equal(normalizeQuery("Café"), "cafe");
    });

    test("returns empty for junk input", () => {
        for (const input of ["", "   ", "!!!", null, undefined, 42]) {
            assert.equal(normalizeQuery(input), "");
        }
    });

    test("tokensOf splits the normalized form", () => {
        assert.deepEqual(tokensOf("Lucid  Dreams!"), ["lucid", "dreams"]);
        assert.deepEqual(tokensOf(""), []);
    });
});

describe("scoreSong", () => {
    const song = {
        title: "Lucid Dreams",
        aliases: ["Remember Me", "Lucid Dreams (Pt. 1)"],
        fileNames: ["REMEMBER ME 2"],
        album: "Goodbye & Good Riddance",
    };

    test("exact title beats exact alias beats exact file name", () => {
        assert.equal(scoreSong(song, "lucid dreams"), SCORES.exactTitle);
        assert.equal(scoreSong(song, "remember me"), SCORES.exactAlias);
        assert.equal(scoreSong(song, "remember me 2"), SCORES.exactFileName);
    });

    test("prefix matches score below exact matches", () => {
        assert.equal(scoreSong(song, "lucid"), SCORES.prefixTitle);
        assert.equal(scoreSong(song, "remember"), SCORES.prefixAlias);
    });

    test("all-token matches score below prefix matches", () => {
        assert.equal(scoreSong(song, "dreams lucid"), SCORES.allTokensTitle);
        assert.equal(scoreSong(song, "me remember"), SCORES.allTokensAlias);
        assert.equal(scoreSong(song, "riddance goodbye"), SCORES.allTokensAlbum);
    });

    test("falls back to a substring hit across the combined text", () => {
        // Reached when the query matches part of a file name but no token rule
        // applies to the title, an alias, or the album.
        const fileOnly = { title: "Untitled", aliases: [], fileNames: ["REMEMBER ME 2"], album: "" };
        assert.equal(scoreSong(fileOnly, "member me"), SCORES.substring);
    });

    test("partial typing still reaches the all-tokens rule", () => {
        // Token containment is substring-based, so "ucid dream" matches the
        // title. Deliberate: it keeps half-typed queries useful, and it still
        // ranks below every exact and prefix rule.
        assert.equal(scoreSong({ ...song, aliases: [], album: "" }, "ucid dream"), SCORES.allTokensTitle);
    });

    test("returns zero for no match and for an empty query", () => {
        assert.equal(scoreSong(song, "completely unrelated text"), 0);
        assert.equal(scoreSong(song, ""), 0);
        assert.equal(scoreSong(song, "!!!"), 0);
    });

    test("takes the highest single rule rather than summing them", () => {
        // Summing would let several weak partial matches outrank one exact title.
        assert.equal(scoreSong(song, "lucid dreams"), SCORES.exactTitle);
    });

    test("tolerates a song missing optional fields", () => {
        assert.doesNotThrow(() => scoreSong({ title: "x" }, "x"));
        assert.equal(scoreSong({ title: "x" }, "x"), SCORES.exactTitle);
    });
});

describe("ranking and tie-breakers", () => {
    const make = (over) => ({
        song: {
            id: 1,
            title: "Same",
            aliases: [],
            fileNames: [],
            album: "",
            category: "released",
            era: { playCount: 0 },
            ...over.song,
        },
        score: over.score ?? 1000,
    });

    test("higher score wins first", () => {
        const list = [make({ score: 500 }), make({ score: 900 })].sort(compareCandidates);
        assert.equal(list[0].score, 900);
    });

    test("category preference: released > unreleased > recording_session > unsurfaced", () => {
        const order = ["unsurfaced", "recording_session", "unreleased", "released"]
            .map((category) => make({ song: { category } }))
            .sort(compareCandidates)
            .map((entry) => entry.song.category);
        assert.deepEqual(order, ["released", "unreleased", "recording_session", "unsurfaced"]);
    });

    test("then higher era play count", () => {
        const list = [
            make({ song: { era: { playCount: 10 } } }),
            make({ song: { era: { playCount: 900 } } }),
        ].sort(compareCandidates);
        assert.equal(list[0].song.era.playCount, 900);
    });

    test("then the shorter title", () => {
        const list = [
            make({ song: { title: "Robbery (EDM Remix) [v1]" } }),
            make({ song: { title: "Robbery" } }),
        ].sort(compareCandidates);
        assert.equal(list[0].song.title, "Robbery");
    });

    test("then the lower id, so identical queries never reshuffle", () => {
        const list = [make({ song: { id: 900 } }), make({ song: { id: 12 } })].sort(compareCandidates);
        assert.equal(list[0].song.id, 12);
    });

    test("ranking is stable across repeated runs", () => {
        const once = top("999", 10).map((entry) => entry.song.id);
        const twice = top("999", 10).map((entry) => entry.song.id);
        assert.deepEqual(once, twice);
    });
});

describe("unplayable records", () => {
    test("are dropped before scoring and never offered", () => {
        const unplayable = songs.filter((song) => !isPlayable(song));
        assert.ok(unplayable.length > 0, "fixtures should include unplayable records");
        for (const song of unplayable) {
            const results = rankSongs(songs, song.title, { limit: 25 });
            assert.ok(
                !results.some((entry) => entry.song.id === song.id),
                `unplayable song ${song.id} "${song.title}" was offered as a result`
            );
        }
    });

    test("isPlayable requires both a stream URL and an audio extension", () => {
        assert.equal(isPlayable({ streamUrl: "https://x/y", path: "a/b.txt" }), false);
        assert.equal(isPlayable({ streamUrl: "", path: "a/b.mp3" }), false);
        assert.equal(isPlayable({ streamUrl: "https://x/y", path: "a/b.mp3" }), true);
        assert.equal(isPlayable(null), false);
    });
});

describe("acceptance queries against the live archive fixtures", () => {
    test("'lucid dreams' resolves to the released Lucid Dreams", () => {
        const outcome = resolveRanking(top("lucid dreams"));
        assert.equal(outcome.kind, "one");
        assert.equal(outcome.song.title, "Lucid Dreams");
        assert.equal(outcome.song.category, "released");
    });

    test("'armed and dangerous' resolves to the released version, not a session variant", () => {
        const outcome = resolveRanking(top("armed and dangerous"));
        assert.equal(outcome.kind, "one");
        assert.equal(outcome.song.title, "Armed And Dangerous");
        assert.equal(outcome.song.category, "released");
    });

    test("'999' neither crashes nor hangs on a broad match", () => {
        const started = Date.now();
        const results = top("999", 25);
        assert.ok(Date.now() - started < 500, "broad query must stay fast");
        assert.ok(results.length > 1, "a broad query should return several candidates");
        assert.equal(resolveRanking(results).kind, "one");
    });

    test("'come and go' matches the ampersand title exactly", () => {
        const outcome = resolveRanking(top("come and go"));
        assert.equal(outcome.kind, "one");
        assert.equal(outcome.song.title, "Come & Go");
    });

    test("'bad day' is genuinely ambiguous and asks rather than guessing", () => {
        const outcome = resolveRanking(top("bad day", 25));
        assert.equal(outcome.kind, "many");
        assert.ok(outcome.candidates.length >= 2);
    });

    test("a query with no match returns none", () => {
        assert.equal(resolveRanking(top("zzzz not a real song zzzz")).kind, "none");
    });

    test("every ranked result for every acceptance query is playable", () => {
        for (const query of ["lucid dreams", "999", "robbery", "righteous", "wishing well", "bad day"]) {
            for (const entry of top(query, 25)) {
                assert.ok(isPlayable(entry.song), `${query} offered unplayable ${entry.song.id}`);
            }
        }
    });
});

describe("resolveRanking", () => {
    const entry = (score, id = 1) => ({ score, song: { id, title: "t", category: "released", era: { playCount: 0 } } });

    test("none for an empty ranking", () => {
        assert.equal(resolveRanking([]).kind, "none");
        assert.equal(resolveRanking(null).kind, "none");
    });

    test("plays directly on an exact-class match", () => {
        assert.equal(resolveRanking([entry(900), entry(899, 2)]).kind, "one");
    });

    test("plays directly when clear of the runner-up by the margin", () => {
        assert.equal(resolveRanking([entry(700), entry(700 - CONFIDENT_MARGIN, 2)]).kind, "one");
    });

    test("asks when the top two are close and neither is exact", () => {
        const outcome = resolveRanking([entry(700), entry(700 - CONFIDENT_MARGIN + 1, 2)]);
        assert.equal(outcome.kind, "many");
    });

    test("a lone result is always confident", () => {
        assert.equal(resolveRanking([entry(200)]).kind, "one");
    });

    test("offers at most five choices", () => {
        const many = Array.from({ length: 20 }, (_, index) => entry(700, index + 1));
        assert.equal(resolveRanking(many).candidates.length, 5);
    });
});
