import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { youtubeVideoUrl } from "../src/audio/youtube.js";
import { createPlayerRegistry } from "../src/audio/registry.js";
import { createRegistry } from "../src/bot/commands/index.js";
import { createPendingResolutions } from "../src/bot/pending.js";
import { UserError } from "../src/core/errors.js";
import { createContext, embedText, lastEmbed, silentLogger, testConfig } from "./helpers/context.mjs";
import { fakeChannel, fakeSourceFactory, fakeVoice, song } from "./helpers/voice.mjs";

/**
 * Commands driven through a fake CommandContext against a real player registry
 * built on fake voice primitives. No gateway, no FFmpeg, no network — but the
 * real command code, the real registry, and the real state machine.
 */

const registry = createRegistry();
const GUILD = "1040000000000000001";

function harness({ resolveResult, searchResult, youtube } = {}) {
    const voice = fakeVoice();
    const createSourceFn = fakeSourceFactory();
    const config = testConfig();

    const players = createPlayerRegistry({
        config,
        logger: silentLogger(),
        ffmpegPath: "C:/fake/ffmpeg.exe",
        youtube,
        rng: () => 0,
        voice,
        createSourceFn,
    });

    const archive = {
        resolve: async () => resolveResult ?? { kind: "one", song: song({ id: 1, title: "Track One" }), score: 1000 },
        randomSongs: async (count) =>
            Array.from({ length: count }, (_, index) =>
                song({ id: 100 + index, title: `Random ${100 + index}`, path: `Random/${100 + index}.mp3` })
            ),
        search: async () => searchResult ?? { totalCount: 0, results: [] },
        stats: async () => ({ totalSongs: 2525, categoryStats: {}, eraStats: {} }),
    };

    const pending = createPendingResolutions({ logger: silentLogger(), timeoutMs: 50 });
    const radio = {
        subscribeCalls: [],
        unsubscribeCalls: [],
        subscribe: async (guildId) => radio.subscribeCalls.push(guildId),
        unsubscribe: (guildId) => radio.unsubscribeCalls.push(guildId),
        streamUrl: () => "https://juicewrldapi.com/juicewrld/radio/stream.mp3",
        buildEmbed: () => ({ color: 1, title: "999 FM" }),
        buildEmbedPayload: () => ({ embeds: [{ color: 1, title: "999 FM" }] }),
        registerStatusMessage: () => () => {},
        clearStatusMessage: () => {},
        fetch: async () => ({}),
    };

    return { players, archive, youtube, pending, radio, voice, createSourceFn, config };
}

function ctxFor(name, deps, { args = [], rest = args.join(" "), voiceChannel = fakeChannel() } = {}) {
    return createContext({
        commandName: name,
        guildId: GUILD,
        args,
        rest,
        voiceChannel,
        deps,
    });
}

const run = async (name, deps, options) => {
    const ctx = ctxFor(name, deps, options);
    await registry.find(name).execute(ctx);
    return ctx;
};

describe("play", () => {
    test("YouTube links queue their own audio and resolve a fresh stream on playback and seek", async () => {
        const videoUrl = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
        const streamUrl = "https://rr1.googlevideo.com/videoplayback";
        const requested = [];
        const youtube = {
            async resolveTrack(query) {
                const youtubeUrl = youtubeVideoUrl(query);
                return youtubeUrl ? { id: "jNQXAC9IVRw", title: "Me at the zoo", durationSeconds: 19, youtubeUrl } : null;
            },
            resolveInputs: async (url) => {
                requested.push(url);
                return [{ url: streamUrl }];
            },
        };
        const deps = harness({ youtube });
        await run("play", deps, { rest: "one" });
        deps.archive.resolve = async () => assert.fail("YouTube must bypass archive search");

        const ctx = await run("playnext", deps, { rest: "<https://youtu.be/jNQXAC9IVRw?list=PL123>" });
        assert.equal(lastEmbed(ctx).url, videoUrl);
        assert.match(lastEmbed(ctx).description, /YouTube/);
        assert.equal(deps.createSourceFn.created.length, 1);

        await run("skip", deps);
        assert.deepEqual(await deps.createSourceFn.last().options.resolveInputs(), [{ url: streamUrl }]);
        await run("seek", deps, { rest: "4" });
        assert.equal(deps.createSourceFn.last().options.seekSeconds, 4);
        await deps.createSourceFn.last().options.resolveInputs();
        assert.deepEqual(requested, [videoUrl, videoUrl]);
        const nowPlaying = lastEmbed(await run("nowplaying", deps));
        assert.equal(nowPlaying.url, videoUrl);
        assert.match(nowPlaying.footer.text, /YouTube/);
    });

    test("YouTube URL forms resolve to one video and playlist pages are rejected", () => {
        const id = "jNQXAC9IVRw";
        const expected = `https://www.youtube.com/watch?v=${id}`;
        for (const url of [
            `https://www.youtube.com/watch?v=${id}&list=PL123`, `youtu.be/${id}`,
            `https://m.youtube.com/shorts/${id}`, `https://youtube.com/live/${id}`,
            `https://music.youtube.com/watch?v=${id}`, `https://www.youtube-nocookie.com/embed/${id}`,
        ]) assert.equal(youtubeVideoUrl(url), expected);
        assert.equal(youtubeVideoUrl("https://youtube.com/clip/UgytZKpehg-hEMBSn3F4AaABCQ"),
            "https://www.youtube.com/clip/UgytZKpehg-hEMBSn3F4AaABCQ");
        assert.equal(youtubeVideoUrl(`https://youtube.com.example.org/watch?v=${id}`), null);
        assert.throws(() => youtubeVideoUrl("https://www.youtube.com/playlist?list=PL123"), UserError);
    });

    test("resolves, joins, and starts the track", async () => {
        const deps = harness();
        const ctx = await run("play", deps, { rest: "lucid dreams" });

        assert.equal(deps.voice.connections.length, 1);
        assert.equal(deps.createSourceFn.created.length, 1);
        assert.equal(embedText(lastEmbed(ctx)).includes("Playing now"), true);
    });

    test("reports the queue position for a later track", async () => {
        const deps = harness();
        await run("play", deps, { rest: "one" });
        const ctx = await run("play", deps, { rest: "two" });
        assert.match(lastEmbed(ctx).author.name, /Queued at position 1/);
    });

    test("refuses when the invoker is not in voice, and never attempts a join", async () => {
        const deps = harness();
        await assert.rejects(() => run("play", deps, { rest: "lucid", voiceChannel: null }), (error) => {
            assert.ok(error instanceof UserError);
            assert.match(error.userMessage, /Join a voice channel first/);
            return true;
        });
        assert.equal(deps.voice.connections.length, 0, "no join attempt at all");
    });

    test("refuses an empty query with a usable example", async () => {
        const deps = harness();
        await assert.rejects(() => run("play", deps, { rest: "" }), /jw!play lucid dreams/);
    });

    test("reports no results with the term and the archive size", async () => {
        const deps = harness({ resolveResult: { kind: "none", query: "zzz", totalSongs: 2525 } });
        const ctx = await run("play", deps, { rest: "zzz" });
        const text = embedText(lastEmbed(ctx));
        assert.ok(text.includes("zzz"));
        assert.ok(text.includes("2525"));
    });

    test("asks when ambiguous and plays the number the user replies with", async () => {
        const candidates = [
            { song: song({ id: 11, title: "Bad Day (v1)" }), score: 700 },
            { song: song({ id: 12, title: "Bad Day (v2)" }), score: 700 },
        ];
        const deps = harness({ resolveResult: { kind: "many", candidates } });

        const ctx = ctxFor("play", deps, { rest: "bad day" });
        await registry.find("play").execute(ctx);

        assert.match(lastEmbed(ctx).author.name, /Which one/);
        assert.equal(deps.createSourceFn.created.length, 0, "nothing plays until the user picks");
        assert.equal(deps.pending.has(GUILD, ctx.channelId, ctx.userId), true);

        // The invoking user answers.
        await deps.pending.handleMessage({
            guildId: GUILD,
            channelId: ctx.channelId,
            author: { id: ctx.userId },
            content: "2",
        });

        assert.equal(deps.createSourceFn.created.length, 1);
        assert.equal(deps.players.get(GUILD).snapshot().current.song.id, 12);
    });

    test("a different user's number does not resolve the prompt", async () => {
        const candidates = [
            { song: song({ id: 11 }), score: 700 },
            { song: song({ id: 12 }), score: 700 },
        ];
        const deps = harness({ resolveResult: { kind: "many", candidates } });
        const ctx = ctxFor("play", deps, { rest: "bad day" });
        await registry.find("play").execute(ctx);

        const handled = await deps.pending.handleMessage({
            guildId: GUILD,
            channelId: ctx.channelId,
            author: { id: "1040000000000000099" },
            content: "1",
        });

        assert.equal(handled, false);
        assert.equal(deps.createSourceFn.created.length, 0);
        assert.equal(deps.pending.has(GUILD, ctx.channelId, ctx.userId), true, "still open for the right user");
    });

    test("an expired prompt cleans up and no longer resolves", async () => {
        const candidates = [{ song: song({ id: 11 }), score: 700 }, { song: song({ id: 12 }), score: 700 }];
        const deps = harness({ resolveResult: { kind: "many", candidates } });
        const ctx = ctxFor("play", deps, { rest: "bad day" });
        await registry.find("play").execute(ctx);

        await new Promise((resolve) => setTimeout(resolve, 90));

        assert.equal(deps.pending.size, 0, "the entry and its timer are gone");
        const handled = await deps.pending.handleMessage({
            guildId: GUILD,
            channelId: ctx.channelId,
            author: { id: ctx.userId },
            content: "1",
        });
        assert.equal(handled, false);
        assert.equal(deps.createSourceFn.created.length, 0);
    });

    test("playnext inserts at the front", async () => {
        const deps = harness();
        await run("play", deps, { rest: "one" });
        await run("play", deps, { rest: "two" });
        const ctx = await run("playnext", deps, { rest: "three" });
        assert.match(lastEmbed(ctx).author.name, /position 1/);
    });
});

describe("playback controls", () => {
    async function playing() {
        const deps = harness();
        await run("play", deps, { rest: "one" });
        await run("play", deps, { rest: "two" });
        return deps;
    }

    test("pause is idempotent and says so", async () => {
        const deps = await playing();
        assert.equal((await run("pause", deps)).replies.at(-1).embeds[0].title, "Paused");
        assert.equal((await run("pause", deps)).replies.at(-1).embeds[0].title, "Already paused");
    });

    test("resume is idempotent and says so", async () => {
        const deps = await playing();
        await run("pause", deps);
        assert.equal((await run("resume", deps)).replies.at(-1).embeds[0].title, "Resumed");
        assert.equal((await run("resume", deps)).replies.at(-1).embeds[0].title, "Already playing");
    });

    test("skip advances and names both tracks", async () => {
        const deps = await playing();
        const ctx = await run("skip", deps);
        const text = embedText(lastEmbed(ctx));
        assert.ok(text.includes("Skipped"));
        assert.ok(text.includes("Track One") || text.includes("Now playing"));
    });

    test("stop tears the player down", async () => {
        const deps = await playing();
        const ctx = await run("stop", deps);
        assert.equal(lastEmbed(ctx).title, "Stopped");
        assert.equal(deps.players.get(GUILD), null);
    });

    test("stop with nothing playing is informational, not an error", async () => {
        const deps = harness();
        const ctx = await run("stop", deps);
        assert.equal(lastEmbed(ctx).title, "Not playing");
    });

    test("commands that need a player refuse cleanly when there is none", async () => {
        const deps = harness();
        for (const name of ["pause", "resume", "skip", "nowplaying", "queue", "shuffle", "clear"]) {
            await assert.rejects(() => run(name, deps), UserError, `${name} should refuse`);
        }
    });

    test("nowplaying renders a progress bar and the requester", async () => {
        const deps = await playing();
        const ctx = await run("nowplaying", deps);
        const embed = lastEmbed(ctx);
        assert.equal(embed.author.name, "Now playing");
        assert.ok(embed.description.includes("⬤"));
        assert.ok(!embedText(embed).includes("NaN"));
    });

    test("queue paginates and reports the page", async () => {
        const deps = await playing();
        const ctx = await run("queue", deps);
        assert.match(lastEmbed(ctx).footer.text, /Page 1 of 1/);
    });

    test("queue rejects a nonsense page number", async () => {
        const deps = await playing();
        await assert.rejects(() => run("queue", deps, { args: ["abc"] }), UserError);
    });

    test("volume reports without an argument and sets with one", async () => {
        const deps = await playing();
        assert.match((await run("volume", deps)).replies.at(-1).embeds[0].title, /Volume: 100%/);
        assert.match((await run("volume", deps, { args: ["60"] })).replies.at(-1).embeds[0].title, /Volume: 60%/);
    });

    test("volume rejects an out-of-range value", async () => {
        const deps = await playing();
        await assert.rejects(() => run("volume", deps, { args: ["900"] }), UserError);
        await assert.rejects(() => run("volume", deps, { args: ["loud"] }), UserError);
    });

    test("loop cycles without an argument and sets with one", async () => {
        const deps = await playing();
        assert.match((await run("loop", deps)).replies.at(-1).embeds[0].title, /Loop: track/);
        assert.match((await run("loop", deps, { args: ["queue"] })).replies.at(-1).embeds[0].title, /Loop: queue/);
    });

    test("loop rejects an unknown mode", async () => {
        const deps = await playing();
        await assert.rejects(() => run("loop", deps, { args: ["sideways"] }), UserError);
    });

    test("seek accepts mm:ss and bare seconds, and rejects junk", async () => {
        const deps = await playing();
        assert.match((await run("seek", deps, { rest: "1:30" })).replies.at(-1).embeds[0].title, /1:30/);
        assert.match((await run("seek", deps, { rest: "45" })).replies.at(-1).embeds[0].title, /0:45/);
        await assert.rejects(() => run("seek", deps, { rest: "half way" }), UserError);
        await assert.rejects(() => run("seek", deps, { rest: "" }), UserError);
    });

    test("remove and move validate their positions", async () => {
        const deps = await playing();
        await assert.rejects(() => run("remove", deps, { args: ["0"] }), UserError);
        await assert.rejects(() => run("move", deps, { args: ["1", "abc"] }), UserError);
        assert.match((await run("remove", deps, { args: ["1"] })).replies.at(-1).embeds[0].title, /Removed/);
    });

    test("clear empties the queue but keeps playing", async () => {
        const deps = await playing();
        const ctx = await run("clear", deps);
        assert.equal(lastEmbed(ctx).title, "Queue cleared");
        assert.ok(deps.players.get(GUILD).snapshot().current, "the current track survives");
    });

    test("join connects without playing, leave disconnects", async () => {
        const deps = harness();
        assert.equal((await run("join", deps)).replies.at(-1).embeds[0].title, "Joined");
        assert.equal(deps.createSourceFn.created.length, 0, "join must not start audio");
        assert.equal((await run("leave", deps)).replies.at(-1).embeds[0].title, "Left");
        assert.equal(deps.players.get(GUILD), null);
    });

    test("leave when not connected is informational", async () => {
        const deps = harness();
        assert.equal((await run("leave", deps)).replies.at(-1).embeds[0].title, "Not connected");
    });
});

describe("random command", () => {
    test("starts endless shuffle and advertises the stop command", async () => {
        const deps = harness();
        const ctx = await run("random", deps);

        const state = deps.players.get(GUILD).snapshot();
        assert.equal(ctx.deferred, true);
        assert.equal(state.randomMode, true);
        assert.equal(state.current.song.id, 100);
        assert.match(embedText(lastEmbed(ctx)), /random stop/i);
    });

    test("stop restores the track and queue that random suspended", async () => {
        const deps = harness();
        await run("play", deps, { rest: "one" });
        await run("play", deps, { rest: "two" });
        await run("random", deps);

        const ctx = await run("random", deps, { args: ["stop"] });
        const state = deps.players.get(GUILD).snapshot();
        assert.equal(state.randomMode, false);
        assert.equal(state.current.song.id, 1);
        assert.equal(state.queueLength, 1);
        assert.match(embedText(lastEmbed(ctx)), /resuming/i);
    });

    test("requires voice before fetching or joining", async () => {
        const deps = harness();
        let calls = 0;
        deps.archive.randomSongs = async () => {
            calls += 1;
            return [];
        };

        await assert.rejects(() => run("random", deps, { voiceChannel: null }), /Join a voice channel first/);
        assert.equal(calls, 0);
        assert.equal(deps.voice.connections.length, 0);
    });

    test("rejects unknown options with valid invocations", async () => {
        const deps = harness();
        await assert.rejects(() => run("random", deps, { args: ["banana"] }), /jw!random stop/);
    });

    test("radio refuses before subscribing while endless shuffle is active", async () => {
        const deps = harness();
        await run("random", deps);

        await assert.rejects(() => run("radio", deps), /random stop/i);
        assert.equal(deps.radio.subscribeCalls.length, 0);
    });
});

describe("radio command", () => {
    test("starting the station suspends the queue", async () => {
        const deps = harness();
        await run("play", deps, { rest: "one" });
        await run("play", deps, { rest: "two" });

        await run("radio", deps);

        const state = deps.players.get(GUILD).snapshot();
        assert.equal(state.radioMode, true);
        assert.equal(state.suspendedQueueLength, 1);
    });

    test("radio stop restores the queue where it was left", async () => {
        const deps = harness();
        await run("play", deps, { rest: "one" });
        await run("radio", deps);
        const ctx = await run("radio", deps, { args: ["stop"] });

        assert.equal(lastEmbed(ctx).title, "Station stopped");
        assert.equal(deps.players.get(GUILD).snapshot().radioMode, false);
    });

    test("radio status reports without joining", async () => {
        const deps = harness();
        await run("radio", deps, { args: ["status"] });
        assert.equal(deps.voice.connections.length, 0, "status must not join voice");
    });

    test("radio stop with no station playing is a user error", async () => {
        const deps = harness();
        await assert.rejects(() => run("radio", deps, { args: ["stop"] }), UserError);
    });

    test("an unknown option is rejected with the valid ones", async () => {
        const deps = harness();
        await assert.rejects(() => run("radio", deps, { args: ["banana"] }), /radio stop/);
    });

    test("queue operations explain themselves rather than silently no-oping", async () => {
        const deps = harness();
        await run("play", deps, { rest: "one" });
        await run("radio", deps);

        for (const name of ["queue", "seek", "loop", "skip", "shuffle"]) {
            await assert.rejects(
                () => run(name, deps, { rest: "1:00", args: ["1:00"] }),
                (error) => {
                    assert.ok(error instanceof UserError, `${name} threw ${error?.name}`);
                    assert.ok(error.userMessage.length > 20, `${name} must explain, not just refuse`);
                    return true;
                },
                name
            );
        }
    });

    test("nowplaying in radio mode shows the station embed", async () => {
        const deps = harness();
        await run("radio", deps);
        const ctx = await run("nowplaying", deps);
        assert.equal(lastEmbed(ctx).title, "999 FM");
    });

    test("pause and volume still work while the station plays", async () => {
        const deps = harness();
        await run("radio", deps);
        assert.equal((await run("pause", deps)).replies.at(-1).embeds[0].title, "Paused");
        assert.match((await run("volume", deps, { args: ["50"] })).replies.at(-1).embeds[0].title, /50%/);
    });
});
