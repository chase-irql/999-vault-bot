import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { parseCommand, tokenize } from "../src/bot/router.js";

const PREFIX = "jw!";

describe("tokenize", () => {
    test("splits on whitespace", () => {
        assert.deepEqual(tokenize("lucid dreams forget me"), ["lucid", "dreams", "forget", "me"]);
    });

    test("keeps double-quoted runs together", () => {
        assert.deepEqual(tokenize('play "bad day" now'), ["play", "bad day", "now"]);
    });

    test("keeps single-quoted runs together", () => {
        assert.deepEqual(tokenize("'armed and dangerous' v2"), ["armed and dangerous", "v2"]);
    });

    test("collapses runs of whitespace", () => {
        assert.deepEqual(tokenize("  a   b \t c \n d "), ["a", "b", "c", "d"]);
    });

    test("drops empty quoted strings", () => {
        assert.deepEqual(tokenize('a "" b'), ["a", "b"]);
    });

    test("handles empty and non-string input", () => {
        assert.deepEqual(tokenize(""), []);
        assert.deepEqual(tokenize(undefined), []);
        assert.deepEqual(tokenize(null), []);
    });
});

describe("parseCommand", () => {
    test("parses a command with arguments", () => {
        assert.deepEqual(parseCommand("jw!play lucid dreams", PREFIX), {
            name: "play",
            args: ["lucid", "dreams"],
            rest: "lucid dreams",
        });
    });

    test("parses a bare command", () => {
        assert.deepEqual(parseCommand("jw!ping", PREFIX), { name: "ping", args: [], rest: "" });
    });

    test("matches the prefix case-insensitively", () => {
        for (const content of ["JW!play x", "Jw!play x", "jW!play x"]) {
            assert.equal(parseCommand(content, PREFIX)?.name, "play", content);
        }
    });

    test("lowercases the command name but preserves argument case", () => {
        const parsed = parseCommand("jw!PLAY Lucid Dreams", PREFIX);
        assert.equal(parsed.name, "play");
        assert.equal(parsed.rest, "Lucid Dreams");
    });

    test("tolerates surrounding and internal whitespace", () => {
        assert.deepEqual(parseCommand("   jw!play    lucid   dreams   ", PREFIX), {
            name: "play",
            args: ["lucid", "dreams"],
            rest: "lucid   dreams",
        });
    });

    test("allows a space between the prefix and the command", () => {
        assert.equal(parseCommand("jw! play lucid", PREFIX)?.name, "play");
    });

    test("preserves quoted arguments", () => {
        const parsed = parseCommand('jw!play "bad day"', PREFIX);
        assert.deepEqual(parsed.args, ["bad day"]);
        assert.equal(parsed.rest, '"bad day"');
    });

    test("rejects the wrong prefix", () => {
        assert.equal(parseCommand("!play lucid", PREFIX), null);
        assert.equal(parseCommand("jw play lucid", PREFIX), null);
        assert.equal(parseCommand("wj!play lucid", PREFIX), null);
    });

    test("rejects a prefix-only message", () => {
        assert.equal(parseCommand("jw!", PREFIX), null);
        assert.equal(parseCommand("  jw!   ", PREFIX), null);
    });

    test("rejects an empty or non-string message", () => {
        assert.equal(parseCommand("", PREFIX), null);
        assert.equal(parseCommand(undefined, PREFIX), null);
        assert.equal(parseCommand(42, PREFIX), null);
    });

    test("rejects an empty prefix so every message is not a command", () => {
        assert.equal(parseCommand("play lucid", ""), null);
    });

    test("ignores messages from bots", () => {
        assert.equal(parseCommand("jw!play lucid", PREFIX, { isBot: true }), null);
    });

    test("honours a custom prefix", () => {
        assert.equal(parseCommand("!!ping", "!!")?.name, "ping");
        assert.equal(parseCommand("jw!ping", "!!"), null);
    });

    test("does not treat the prefix inside a word as a command", () => {
        assert.equal(parseCommand("hey jw!play", PREFIX), null);
    });
});
