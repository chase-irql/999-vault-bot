import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createCache } from "../src/api/cache.js";
import { fakeClock } from "./helpers/context.mjs";

describe("createCache", () => {
    test("stores and returns a value", () => {
        const cache = createCache({ clock: fakeClock() });
        cache.set("a", 1);
        assert.equal(cache.get("a"), 1);
        assert.equal(cache.has("a"), true);
    });

    test("misses return undefined rather than throwing", () => {
        const cache = createCache({ clock: fakeClock() });
        assert.equal(cache.get("nope"), undefined);
        assert.equal(cache.has("nope"), false);
    });

    test("entries expire once the TTL has elapsed", () => {
        const clock = fakeClock();
        const cache = createCache({ ttlMs: 1_000, clock });
        cache.set("a", 1);
        clock.advance(999);
        assert.equal(cache.get("a"), 1, "still fresh one millisecond before expiry");
        clock.advance(1);
        assert.equal(cache.get("a"), undefined, "expired exactly at the TTL");
        assert.equal(cache.size, 0, "an expired entry is dropped, not just hidden");
    });

    test("evicts the least recently used entry past the cap", () => {
        const cache = createCache({ maxEntries: 2, clock: fakeClock() });
        cache.set("a", 1);
        cache.set("b", 2);
        cache.get("a"); // "a" is now the most recently used
        cache.set("c", 3);
        assert.equal(cache.get("b"), undefined, "b was least recently used");
        assert.equal(cache.get("a"), 1);
        assert.equal(cache.get("c"), 3);
    });

    test("re-setting a key refreshes its position and its expiry", () => {
        const clock = fakeClock();
        const cache = createCache({ ttlMs: 1_000, clock });
        cache.set("a", 1);
        clock.advance(900);
        cache.set("a", 2);
        clock.advance(900);
        assert.equal(cache.get("a"), 2);
    });

    test("clear empties everything", () => {
        const cache = createCache({ clock: fakeClock() });
        cache.set("a", 1);
        cache.clear();
        assert.equal(cache.size, 0);
        assert.deepEqual(cache.stats, { hits: 0, misses: 0, size: 0 });
    });
});

describe("read-through wrapping", () => {
    test("a repeated query inside the TTL produces exactly one call", async () => {
        const clock = fakeClock();
        const cache = createCache({ ttlMs: 300_000, clock });
        let calls = 0;
        const produce = async () => {
            calls += 1;
            return "value";
        };

        assert.equal(await cache.wrap("q", produce), "value");
        assert.equal(await cache.wrap("q", produce), "value");
        assert.equal(await cache.wrap("q", produce), "value");
        assert.equal(calls, 1, "a warm cache must not touch the network");
    });

    test("a call is made again once the entry expires", async () => {
        const clock = fakeClock();
        const cache = createCache({ ttlMs: 300_000, clock });
        let calls = 0;
        const produce = async () => {
            calls += 1;
            return calls;
        };

        await cache.wrap("q", produce);
        clock.advance(300_000);
        await cache.wrap("q", produce);
        assert.equal(calls, 2);
    });

    test("concurrent misses for one key share a single in-flight call", async () => {
        const cache = createCache({ clock: fakeClock() });
        let calls = 0;
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const produce = async () => {
            calls += 1;
            await gate;
            return "shared";
        };

        const all = Promise.all([cache.wrap("q", produce), cache.wrap("q", produce), cache.wrap("q", produce)]);
        release();
        assert.deepEqual(await all, ["shared", "shared", "shared"]);
        assert.equal(calls, 1, "two guilds searching the same term must issue one request");
    });

    test("a failed call is not cached and does not wedge the key", async () => {
        const cache = createCache({ clock: fakeClock() });
        let calls = 0;
        const failing = async () => {
            calls += 1;
            throw new Error("archive down");
        };

        await assert.rejects(() => cache.wrap("q", failing), /archive down/);
        await assert.rejects(() => cache.wrap("q", failing), /archive down/);
        assert.equal(calls, 2, "a failure must be retried, not memoized");

        assert.equal(await cache.wrap("q", async () => "recovered"), "recovered");
    });

    test("different keys do not bleed into each other", async () => {
        const cache = createCache({ clock: fakeClock() });
        const a = await cache.wrap("guild-a-query", async () => "A");
        const b = await cache.wrap("guild-b-query", async () => "B");
        assert.equal(a, "A");
        assert.equal(b, "B");
        assert.equal(cache.get("guild-a-query"), "A");
    });
});
