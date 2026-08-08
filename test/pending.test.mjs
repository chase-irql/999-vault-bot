import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createPendingResolutions } from "../src/bot/pending.js";
import { silentLogger } from "./helpers/context.mjs";

/**
 * Disambiguation prompts, with the multi-user case that matters: two people
 * prompting in the same channel must not be able to answer each other.
 */

const GUILD = "1040000000000000001";
const CHANNEL = "1040000000000000002";
const USER_1 = "1040000000000000003";
const USER_2 = "1040000000000000004";

const message = (userId, content, channelId = CHANNEL) => ({
    guildId: GUILD,
    channelId,
    author: { id: userId },
    content,
});

const candidates = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];

function build(timeoutMs = 60_000) {
    return createPendingResolutions({ logger: silentLogger(), timeoutMs });
}

describe("resolving a prompt", () => {
    test("a numeric reply picks the matching candidate", async () => {
        const pending = build();
        const chosen = [];
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: (song) => chosen.push(song) });

        assert.equal(await pending.handleMessage(message(USER_1, "3")), true);
        assert.deepEqual(chosen, [{ id: 3 }]);
        assert.equal(pending.size, 0, "resolving must remove the entry and its timer");
    });

    test("tolerates surrounding whitespace", async () => {
        const pending = build();
        let chosen = null;
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: (song) => (chosen = song) });
        assert.equal(await pending.handleMessage(message(USER_1, "  2  ")), true);
        assert.deepEqual(chosen, { id: 2 });
    });

    test("ignores a number outside the offered range", async () => {
        const pending = build();
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: () => {} });
        for (const content of ["0", "6", "-1", "99"]) {
            assert.equal(await pending.handleMessage(message(USER_1, content)), false, content);
        }
        assert.equal(pending.size, 1, "an invalid answer must not consume the prompt");
    });

    test("ignores non-numeric messages so normal chat still flows", async () => {
        const pending = build();
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: () => {} });
        for (const content of ["hello", "jw!play something", "1.5", ""]) {
            assert.equal(await pending.handleMessage(message(USER_1, content)), false, content);
        }
    });

    test("a message with no open prompt is not consumed", async () => {
        const pending = build();
        assert.equal(await pending.handleMessage(message(USER_1, "1")), false);
    });

    test("a failing handler still closes the prompt rather than wedging it", async () => {
        const pending = build();
        pending.open({
            guildId: GUILD,
            channelId: CHANNEL,
            userId: USER_1,
            candidates,
            onChoose: () => {
                throw new Error("enqueue failed");
            },
        });
        assert.equal(await pending.handleMessage(message(USER_1, "1")), true);
        assert.equal(pending.size, 0);
    });
});

describe("isolation between users and channels", () => {
    test("user 2 cannot resolve user 1's prompt", async () => {
        const pending = build();
        const chosen = [];
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: (s) => chosen.push(["u1", s]) });

        // User 2 types a number in the same channel while user 1's prompt is open.
        assert.equal(await pending.handleMessage(message(USER_2, "2")), false);
        assert.deepEqual(chosen, [], "user 1's prompt must be untouched");
        assert.equal(pending.has(GUILD, CHANNEL, USER_1), true, "and must still be open");

        assert.equal(await pending.handleMessage(message(USER_1, "2")), true);
        assert.deepEqual(chosen, [["u1", { id: 2 }]]);
    });

    test("two users can hold prompts at once and each resolves its own", async () => {
        const pending = build();
        const chosen = [];
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: (s) => chosen.push(["u1", s.id]) });
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_2, candidates, onChoose: (s) => chosen.push(["u2", s.id]) });
        assert.equal(pending.size, 2);

        await pending.handleMessage(message(USER_2, "5"));
        await pending.handleMessage(message(USER_1, "1"));
        assert.deepEqual(chosen, [["u2", 5], ["u1", 1]]);
    });

    test("a prompt does not carry across channels", async () => {
        const pending = build();
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: () => {} });
        assert.equal(await pending.handleMessage(message(USER_1, "1", "1040000000000000099")), false);
    });

    test("opening a second prompt for the same user replaces the first", async () => {
        const pending = build();
        const chosen = [];
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: () => chosen.push("first") });
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: () => chosen.push("second") });

        assert.equal(pending.size, 1, "prompts must not stack");
        await pending.handleMessage(message(USER_1, "1"));
        assert.deepEqual(chosen, ["second"]);
    });
});

describe("expiry", () => {
    test("expires after the timeout and cleans up without leaking a listener", async () => {
        const pending = build(20);
        let expired = false;
        pending.open({
            guildId: GUILD,
            channelId: CHANNEL,
            userId: USER_1,
            candidates,
            onChoose: () => assert.fail("must not resolve after expiry"),
            onExpire: () => {
                expired = true;
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 60));

        assert.equal(expired, true);
        assert.equal(pending.size, 0, "the entry must be gone, not just inert");
        assert.equal(await pending.handleMessage(message(USER_1, "1")), false);
    });

    test("cancelling removes the prompt and its timer", () => {
        const pending = build();
        const cancel = pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: () => {} });
        cancel();
        assert.equal(pending.size, 0);
    });

    test("clear drops every prompt, so shutdown holds no timers", () => {
        const pending = build();
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_1, candidates, onChoose: () => {} });
        pending.open({ guildId: GUILD, channelId: CHANNEL, userId: USER_2, candidates, onChoose: () => {} });
        pending.clear();
        assert.equal(pending.size, 0);
    });
});
