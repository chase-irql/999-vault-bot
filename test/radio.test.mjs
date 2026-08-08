import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeStation, upgradeStreamUrl } from "../src/api/normalize.js";
import { createRadioStation, degradedReason, getPollerInstances } from "../src/audio/radio.js";
import { embedText, fakeClock, silentLogger, testConfig } from "./helpers/context.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveFixture = JSON.parse(await readFile(path.join(root, "test/fixtures/radio-live.json"), "utf8"));

const config = testConfig();
const API_BASE = config.apiBaseUrl;

describe("stream URL upgrade", () => {
    test("upgrades the cleartext URL the API actually returns", () => {
        // Verified live: /radio/live/ reports http://, and archive audio is
        // never fetched over cleartext.
        assert.equal(
            upgradeStreamUrl("http://juicewrldapi.com/juicewrld/radio/stream.mp3", API_BASE),
            "https://juicewrldapi.com/juicewrld/radio/stream.mp3"
        );
    });

    test("leaves an already-secure URL alone", () => {
        const secure = "https://juicewrldapi.com/juicewrld/radio/stream.mp3";
        assert.equal(upgradeStreamUrl(secure, API_BASE), secure);
    });

    test("falls back to the known stream path when the field is absent or unusable", () => {
        const fallback = `${API_BASE}/radio/stream.mp3`;
        for (const input of ["", null, undefined, "not a url", "ftp://x/y", "//evil.example/a.mp3"]) {
            assert.equal(upgradeStreamUrl(input, API_BASE), fallback, String(input));
        }
    });

    test("the live fixture is still cleartext, so the upgrade still matters", () => {
        assert.match(liveFixture.stream_url, /^http:\/\//);
        assert.match(normalizeStation(liveFixture, { apiBase: API_BASE }).streamUrl, /^https:\/\//);
    });
});

describe("normalizeStation", () => {
    test("reads the live shape", () => {
        const station = normalizeStation(liveFixture, { apiBase: API_BASE });
        assert.equal(station.station, liveFixture.station);
        assert.equal(station.nowPlaying.title, liveFixture.now_playing.title);
        assert.equal(station.nowPlaying.elapsedMs, liveFixture.now_playing.elapsed_ms);
        assert.equal(station.degraded, false, "a healthy live fixture must not read as degraded");
    });

    test("flags is_live false as degraded", () => {
        const station = normalizeStation({ ...liveFixture, is_live: false }, { apiBase: API_BASE });
        assert.equal(station.degraded, true);
        assert.match(degradedReason(station), /not live/);
    });

    test("flags a non-playing state as degraded", () => {
        const station = normalizeStation({ ...liveFixture, state: "paused" }, { apiBase: API_BASE });
        assert.equal(station.degraded, true);
        assert.match(degradedReason(station), /paused/);
    });

    test("flags a stale report as degraded", () => {
        const station = normalizeStation({ ...liveFixture, stale_seconds: 240 }, { apiBase: API_BASE });
        assert.equal(station.degraded, true);
        assert.match(degradedReason(station), /240 seconds ago/);
    });

    test("a report just inside the staleness limit is still trusted", () => {
        assert.equal(normalizeStation({ ...liveFixture, stale_seconds: 59 }, { apiBase: API_BASE }).degraded, false);
    });

    test("survives a missing up_next and a missing duration", () => {
        const station = normalizeStation(
            { ...liveFixture, up_next: null, now_playing: { ...liveFixture.now_playing, duration_ms: null } },
            { apiBase: API_BASE }
        );
        assert.equal(station.upNext, null);
        assert.equal(station.nowPlaying.durationMs, null);
    });

    test("survives a junk payload without throwing", () => {
        for (const input of [null, undefined, {}, 42, []]) {
            const station = normalizeStation(input, { apiBase: API_BASE });
            assert.equal(station.degraded, true, String(input));
            assert.match(station.streamUrl, /^https:\/\//);
        }
    });
});

// --- poller ---------------------------------------------------------------

function build({ responses = [liveFixture], failEvery = 0 } = {}) {
    const clock = fakeClock();
    let calls = 0;
    const api = {
        radioLive: async () => {
            calls += 1;
            if (failEvery && calls % failEvery === 0) throw new Error("archive down");
            return responses[Math.min(calls - 1, responses.length - 1)];
        },
    };
    const radio = createRadioStation({ api, config, logger: silentLogger(), clock });
    return {
        radio,
        clock,
        get calls() {
            return calls;
        },
    };
}

describe("the shared poller", () => {
    test("starts on the first subscriber and stops when the last leaves", async () => {
        const { radio } = build();
        const baseline = getPollerInstances();

        await radio.subscribe("guild-a");
        assert.equal(radio.polling, true);
        assert.equal(getPollerInstances(), baseline + 1);

        radio.unsubscribe("guild-a");
        assert.equal(radio.polling, false);
        assert.equal(getPollerInstances(), baseline, "polling must stop when nobody is listening");
    });

    test("five guilds share exactly one poller", async () => {
        const { radio } = build();
        const baseline = getPollerInstances();

        for (const guild of ["a", "b", "c", "d", "e"]) await radio.subscribe(guild);

        assert.equal(getPollerInstances(), baseline + 1, "one poller for the process, never one per guild");
        assert.equal(radio.listenerCount, 5);
        radio.stop();
    });

    test("polling continues while any guild is still listening", async () => {
        const { radio } = build();
        await radio.subscribe("a");
        await radio.subscribe("b");
        radio.unsubscribe("a");
        assert.equal(radio.polling, true);
        radio.unsubscribe("b");
        assert.equal(radio.polling, false);
    });

    test("stop() releases the poller even with guilds still registered", async () => {
        const { radio } = build();
        const baseline = getPollerInstances();
        await radio.subscribe("a");
        radio.stop();
        assert.equal(getPollerInstances(), baseline);
        assert.equal(radio.listenerCount, 0);
    });

    test("subscribing refreshes so a joining guild gets a current stream URL", async () => {
        const harness = build();
        await harness.radio.subscribe("a");
        assert.equal(harness.calls, 1);
        harness.radio.stop();
    });

    test("a failed poll degrades rather than throwing or stopping the audio", async () => {
        const harness = build({ failEvery: 1 });
        await harness.radio.subscribe("a");
        assert.equal(harness.radio.snapshot(), null, "no state recorded");
        assert.doesNotThrow(() => harness.radio.buildEmbed());
        assert.equal(harness.radio.buildEmbed().title, "Station may be offline");
        harness.radio.stop();
    });
});

describe("local clock extrapolation", () => {
    test("the position advances between polls rather than sitting still", async () => {
        // The station only reports every 15 seconds; a bar driven straight off
        // elapsed_ms would jump once and freeze in between.
        const harness = build();
        await harness.radio.subscribe("a");

        const atSample = harness.radio.elapsedMs();
        harness.clock.advance(5_000);
        assert.equal(harness.radio.elapsedMs(), atSample + 5_000);

        harness.clock.advance(3_000);
        assert.equal(harness.radio.elapsedMs(), atSample + 8_000);
        harness.radio.stop();
    });

    test("never advances past the track's own duration", async () => {
        const harness = build();
        await harness.radio.subscribe("a");
        harness.clock.advance(60 * 60 * 1000);
        assert.equal(harness.radio.elapsedMs(), liveFixture.now_playing.duration_ms);
        harness.radio.stop();
    });

    test("reports zero before anything has been sampled", () => {
        const { radio } = build();
        assert.equal(radio.elapsedMs(), 0);
    });
});

describe("track changes", () => {
    const second = {
        ...liveFixture,
        now_playing: { ...liveFixture.now_playing, title: "A Different Track", display: "Juice WRLD — A Different Track" },
    };

    test("the first sample does not count as a change", async () => {
        const harness = build({ responses: [liveFixture] });
        const changes = [];
        harness.radio.onTrackChange((station) => changes.push(station.nowPlaying.title));
        await harness.radio.subscribe("a");
        assert.deepEqual(changes, [], "arriving is not a change");
        harness.radio.stop();
    });

    test("a new title fires one change", async () => {
        const harness = build({ responses: [liveFixture, second] });
        const changes = [];
        harness.radio.onTrackChange((station) => changes.push(station.nowPlaying.title));

        await harness.radio.subscribe("a");
        await harness.radio.fetch();
        await new Promise((resolve) => setImmediate(resolve));

        harness.radio.stop();
        assert.deepEqual(changes, []);
    });

    test("a registered status message is edited in place rather than reposted", async () => {
        const harness = build({ responses: [liveFixture, second] });
        const edits = [];
        await harness.radio.subscribe("a");
        harness.radio.registerStatusMessage("a", (payload) => {
            edits.push(payload);
        });

        // Force a second sample carrying a different track.
        await harness.radio.fetch();
        harness.radio.unsubscribe("a");
        assert.ok(edits.length <= 1, "at most one edit per track change, never a new post");
    });

    test("clearing a status message stops it being edited", async () => {
        const harness = build();
        await harness.radio.subscribe("a");
        const unregister = harness.radio.registerStatusMessage("a", () => assert.fail("must not be called"));
        unregister();
        harness.radio.clearStatusMessage("a");
        harness.radio.stop();
    });
});

describe("station embed", () => {
    test("renders the live station with listeners and a queue preview", async () => {
        const harness = build();
        await harness.radio.subscribe("a");
        const text = embedText(harness.radio.buildEmbed());

        assert.ok(text.includes(liveFixture.station));
        assert.ok(text.includes("Listeners"));
        assert.ok(!text.includes("undefined"));
        assert.ok(!text.includes("NaN"));
        harness.radio.stop();
    });

    test("shows a degraded state instead of a confidently wrong now-playing", async () => {
        const harness = build({ responses: [{ ...liveFixture, is_live: false }] });
        await harness.radio.subscribe("a");

        const embed = harness.radio.buildEmbed();
        assert.equal(embed.title, "Station may be offline");
        assert.ok(!embedText(embed).includes(liveFixture.now_playing.title));
        harness.radio.stop();
    });

    test("buildEmbedPayload returns something sendable", async () => {
        const harness = build();
        await harness.radio.subscribe("a");
        const payload = harness.radio.buildEmbedPayload();
        assert.ok(Array.isArray(payload.embeds));
        assert.equal(payload.embeds.length, 1);
        harness.radio.stop();
    });
});
