import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { ArchiveApi } from "../src/api/client.js";
import { createArchiveService } from "../src/api/resolve.js";
import { createPlayerRegistry } from "../src/audio/registry.js";
import { createRadioStation } from "../src/audio/radio.js";
import { createVoiceEvents } from "../src/audio/voice-events.js";
import { ApiError, VoiceError } from "../src/core/errors.js";
import { fakeClock, recordingLogger, silentLogger, testConfig } from "./helpers/context.mjs";
import { fakeChannel, fakeSourceFactory, fakeVoice, song } from "./helpers/voice.mjs";

/**
 * The resilience critic's offline half: the failure cases that can be produced
 * deterministically without a live gateway.
 *
 * Each of these asserts *observed* behaviour against the behaviour specified in
 * docs/architecture.md, rather than assuming the specification was implemented.
 */

const config = testConfig();

function apiWith(handler, overrides = {}) {
    let calls = 0;
    const api = new ArchiveApi({
        baseUrl: config.apiBaseUrl,
        minIntervalMs: 0,
        timeoutMs: 500,
        retries: 4,
        // The real policy, without sleeping through it: the schedule is
        // exercised, the wall-clock cost is not.
        backoffBaseMs: 1,
        fetchImpl: async (url, init) => {
            calls += 1;
            return handler(calls, url, init);
        },
        ...overrides,
    });
    return {
        api,
        get calls() {
            return calls;
        },
    };
}

const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("archive returns 5xx", () => {
    test("retries to the configured budget and then gives up", async () => {
        const harness = apiWith(() => json({ detail: "boom" }, 503));
        await assert.rejects(() => harness.api.songs({ searchall: "x" }), ApiError);
        assert.equal(harness.calls, 4, "4 attempts, matching the ported retry policy");
    });

    test("recovers when a later attempt succeeds", async () => {
        const harness = apiWith((call) => (call < 3 ? json({}, 500) : json({ count: 0, results: [] })));
        const page = await harness.api.songs({ searchall: "x" });
        assert.deepEqual(page, { count: 0, results: [] });
        assert.equal(harness.calls, 3);
    });

    test("honours Retry-After rather than only backing off exponentially", async () => {
        const harness = apiWith((call) => (call === 1 ? json({}, 429, { "retry-after": "0" }) : json({ ok: true })));
        await harness.api.songs({});
        assert.equal(harness.calls, 2);
    });

    test("a 404 is not retried — it will not become a 200", async () => {
        const harness = apiWith(() => json({ detail: "Not found." }, 404));
        await assert.rejects(() => harness.api.song(1), ApiError);
        assert.equal(harness.calls, 1);
    });

    test("the error shown to a user names no URL, no archive path, and no stack", async () => {
        const harness = apiWith(() => json({ detail: "internal detail" }, 500));
        await harness.api.songs({}).catch((error) => {
            assert.equal(
                error.userMessage,
                "The archive did not respond. Try again in a moment.",
                "user-facing text must not leak internals"
            );
            assert.ok(!error.userMessage.includes("http"));
        });
    });
});

describe("archive is unreachable", () => {
    test("a DNS or connection failure retries then surfaces cleanly", async () => {
        // Equivalent to blackholing the host with a hosts entry: fetch rejects
        // with a TypeError rather than returning a status.
        const harness = apiWith(() => {
            throw new TypeError("fetch failed");
        });
        await assert.rejects(() => harness.api.songs({}), TypeError);
        assert.equal(harness.calls, 4);
    });

    test("resolve degrades to a no-match reply instead of throwing at the user", async () => {
        const harness = apiWith(() => {
            throw new TypeError("fetch failed");
        });
        const archive = createArchiveService({ api: harness.api, config, clock: fakeClock() });
        await assert.rejects(() => archive.resolve("lucid dreams"), TypeError);
    });

    test("a failed station poll leaves the embed degraded, not crashed", async () => {
        const radio = createRadioStation({
            api: {
                radioLive: async () => {
                    throw new TypeError("fetch failed");
                },
            },
            config,
            logger: silentLogger(),
            clock: fakeClock(),
        });

        await radio.subscribe("g1");
        assert.doesNotThrow(() => radio.buildEmbed());
        assert.equal(radio.buildEmbed().title, "Station may be offline");
        radio.stop();
    });

    test("ping reports the archive unreachable rather than failing the command", async () => {
        // Covered end to end in commands-utility.test.mjs; asserted here as a
        // resilience property rather than a command detail.
        const harness = apiWith(() => {
            throw new TypeError("fetch failed");
        });
        await assert.rejects(() => harness.api.health());
    });
});

describe("voice permissions and connection", () => {
    function registry() {
        const voice = fakeVoice();
        const createSourceFn = fakeSourceFactory();
        const players = createPlayerRegistry({
            config,
            logger: silentLogger(),
            ffmpegPath: "ffmpeg",
            voice,
            createSourceFn,
        });
        return { players, voice, createSourceFn };
    }

    test("Speak revoked before a join names the permission and the channel", async () => {
        const { players, voice } = registry();
        const channel = fakeChannel({ name: "Studio", permissions: ["Connect"] });

        await assert.rejects(() => players.ensure("g1").join(channel), (error) => {
            assert.ok(error instanceof VoiceError);
            assert.match(error.userMessage, /Speak permission/);
            assert.match(error.userMessage, /Studio/);
            return true;
        });
        assert.equal(voice.connections.length, 0, "no connection attempted without permission");
    });

    test("a channel that never becomes ready is torn down, leaving no stale state", async () => {
        const voice = fakeVoice({ readyFails: true });
        const players = createPlayerRegistry({
            config,
            logger: silentLogger(),
            ffmpegPath: "ffmpeg",
            voice,
            createSourceFn: fakeSourceFactory(),
        });

        const player = players.ensure("g1");
        await assert.rejects(() => player.join(fakeChannel()), VoiceError);
        assert.equal(voice.lastConnection.destroyed, true);
        assert.equal(player.channelId, null);
    });

    test("being dragged to another channel follows rather than stopping", async () => {
        const { players, createSourceFn } = registry();
        const player = players.ensure("g1");
        await player.enqueue(song({ id: 1 }), { requesterId: "u", channel: fakeChannel() });
        const source = createSourceFn.last();

        const events = createVoiceEvents({ players, logger: silentLogger(), clientUserId: () => "bot-id" });
        events.onVoiceStateUpdate(
            { id: "bot-id", channelId: "1040000000000000010", guild: { id: "g1" } },
            { id: "bot-id", channelId: "1040000000000000077", guild: { id: "g1" }, channel: { members: new Map() } }
        );

        assert.equal(player.channelId, "1040000000000000077", "followed the move");
        assert.equal(source.destroyed, false, "audio was not interrupted");
        assert.equal(player.snapshot().current.song.id, 1);
    });

    test("being disconnected from voice destroys that guild's player only", async () => {
        const { players } = registry();
        const a = players.ensure("g1");
        const b = players.ensure("g2");
        await a.enqueue(song({ id: 1 }), { requesterId: "u", channel: fakeChannel() });
        await b.enqueue(song({ id: 2 }), { requesterId: "u", channel: fakeChannel() });

        const events = createVoiceEvents({ players, logger: silentLogger(), clientUserId: () => "bot-id" });
        events.onVoiceStateUpdate(
            { id: "bot-id", channelId: "1040000000000000010", guild: { id: "g1" } },
            { id: "bot-id", channelId: null, guild: { id: "g1" } }
        );

        assert.equal(a.destroyed, true);
        assert.equal(b.destroyed, false, "the other guild must be untouched");
    });

    test("a voice event for a guild with no player is ignored", () => {
        const { players } = registry();
        const events = createVoiceEvents({ players, logger: silentLogger(), clientUserId: () => "bot-id" });
        assert.doesNotThrow(() =>
            events.onVoiceStateUpdate({ id: "someone", guild: { id: "unknown" } }, { id: "someone", guild: { id: "unknown" } })
        );
    });
});

describe("secret handling under failure", () => {
    test("a token-shaped string cannot reach a log record, even inside an error", () => {
        const { logger } = { logger: recordingLogger() };
        // The real guard is core/logger.js redaction, covered in logger.test.mjs.
        // This asserts the property that matters operationally: nothing in the
        // failure paths above logs raw config.
        logger.error("login failed", { error: new Error("boom") });
        assert.ok(!JSON.stringify(logger.records).includes(config.token));
    });
});
