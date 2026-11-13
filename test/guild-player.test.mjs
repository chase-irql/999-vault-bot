import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createGuildPlayer } from "../src/audio/guild-player.js";
import { UserError, VoiceError } from "../src/core/errors.js";
import { silentLogger, testConfig } from "./helpers/context.mjs";
import { fakeChannel, fakeSourceFactory, fakeVoice, song } from "./helpers/voice.mjs";

/**
 * The state machine driven end to end with fake voice primitives: no gateway, no
 * UDP socket, no FFmpeg process.
 */

function build({ config = testConfig(), voiceOptions = {}, rng = () => 0 } = {}) {
    const voice = fakeVoice(voiceOptions);
    const createSourceFn = fakeSourceFactory();
    const player = createGuildPlayer({
        guildId: "1040000000000000001",
        config,
        logger: silentLogger(),
        ffmpegPath: "C:/fake/ffmpeg.exe",
        rng,
        voice,
        createSourceFn,
    });
    return { player, voice, createSourceFn, channel: fakeChannel() };
}

const enqueue = (player, channel, id) =>
    player.enqueue(song({ id, title: `Track ${id}` }), { requesterId: "u1", channel });

function endlessFetcher(start = 100) {
    let nextId = start;
    const calls = [];
    const fetch = async (count, { exclude = new Set() } = {}) => {
        calls.push({ count, exclude: new Set(exclude) });
        const songs = [];
        while (songs.length < count) {
            const id = nextId++;
            if (exclude.has(id)) continue;
            songs.push(song({ id, title: `Random ${id}`, path: `Random/${id}.mp3` }));
        }
        return songs;
    };
    fetch.calls = calls;
    return fetch;
}

describe("connection lifecycle", () => {
    test("joining connects once and reports the channel", async () => {
        const { player, voice, channel } = build();
        await player.join(channel);
        assert.equal(voice.connections.length, 1);
        assert.equal(player.channelId, channel.id);
        assert.equal(voice.lastConnection.subscribed, voice.lastPlayer, "the player must be subscribed");
    });

    test("joining the same channel twice does not stack connections", async () => {
        const { player, voice, channel } = build();
        await player.join(channel);
        await player.join(channel);
        assert.equal(voice.connections.length, 1);
    });

    test("refuses without a channel and never attempts a join", async () => {
        const { player, voice } = build();
        await assert.rejects(() => player.join(null), UserError);
        assert.equal(voice.connections.length, 0);
    });

    test("names the missing permission and the channel", async () => {
        const { player } = build();
        const channel = fakeChannel({ name: "Studio", permissions: ["Connect"] });
        await assert.rejects(() => player.join(channel), (error) => {
            assert.ok(error instanceof VoiceError);
            assert.match(error.userMessage, /Speak permission/);
            assert.match(error.userMessage, /Studio/);
            return true;
        });
    });

    test("names both permissions when both are missing", async () => {
        const { player } = build();
        await assert.rejects(() => player.join(fakeChannel({ permissions: [] })), (error) => {
            assert.match(error.userMessage, /Connect and Speak permissions/);
            return true;
        });
    });

    test("a connection that never becomes ready is destroyed, not left dangling", async () => {
        const { player, voice, channel } = build({ voiceOptions: { readyFails: true } });
        await assert.rejects(() => player.join(channel), VoiceError);
        assert.equal(voice.lastConnection.destroyed, true);
        assert.equal(player.channelId, null, "a failed join must not leave a stale channel id");
    });
});

describe("playback", () => {
    test("the first track starts immediately", async () => {
        const { player, channel, createSourceFn } = build();
        const result = await enqueue(player, channel, 1);
        assert.equal(result.started, true);
        assert.equal(result.position, 0);
        assert.equal(createSourceFn.created.length, 1);
        assert.equal(player.snapshot().current.song.id, 1);
    });

    test("later tracks queue and report their position", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        const second = await enqueue(player, channel, 2);
        const third = await enqueue(player, channel, 3);

        assert.deepEqual([second.started, second.position], [false, 1]);
        assert.deepEqual([third.started, third.position], [false, 2]);
        assert.equal(createSourceFn.created.length, 1, "queuing must not start a second source");
    });

    test("playnext jumps the queue", async () => {
        const { player, channel } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        await player.enqueue(song({ id: 9 }), { requesterId: "u1", channel, next: true });
        assert.deepEqual(player.snapshot().queue.map((entry) => entry.song.id), [9, 2]);
    });

    test("the source is built from the song's HTTPS stream URL", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        assert.match(createSourceFn.last().options.url, /^https:\/\//);
        assert.equal(createSourceFn.last().options.seekSeconds, 0);
    });
});

describe("advancing", () => {
    test("a finished track advances to the next and destroys the old source", async () => {
        const { player, voice, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        const first = createSourceFn.last();

        voice.lastPlayer.finishTrack();
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(player.snapshot().current.song.id, 2);
        assert.equal(first.destroyed, true, "the finished source must be torn down");
    });

    test("an empty queue goes idle rather than replaying", async () => {
        const { player, voice, channel } = build();
        await enqueue(player, channel, 1);

        voice.lastPlayer.finishTrack();
        await new Promise((resolve) => setImmediate(resolve));

        const state = player.snapshot();
        assert.equal(state.current, null);
        assert.equal(state.status, "idle");
    });

    test("track loop replays the same song when it ends", async () => {
        const { player, voice, channel } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        player.setLoop("track");

        voice.lastPlayer.finishTrack();
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(player.snapshot().current.song.id, 1);
        assert.equal(player.snapshot().queueLength, 1, "the queue must not have moved");
    });

    test("skip under track loop still moves on", async () => {
        const { player, voice, channel } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        player.setLoop("track");

        const result = await player.skip();
        assert.equal(result.skipped.song.id, 1);
        assert.equal(result.next.song.id, 2);
        assert.equal(player.snapshot().loop, "track", "the mode itself stays set");
        void voice;
    });

    test("queue loop sends the finished track to the back", async () => {
        const { player, voice, channel } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        player.setLoop("queue");

        voice.lastPlayer.finishTrack();
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(player.snapshot().current.song.id, 2);
        assert.deepEqual(player.snapshot().queue.map((entry) => entry.song.id), [1]);
    });

    test("a failing source skips the track instead of stalling on it", async () => {
        const { player, voice, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        await enqueue(player, channel, 3);
        player.setLoop("queue");

        createSourceFn.created[0].options.onError(new Error("ffmpeg died"));
        voice.lastPlayer.finishTrack();
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(player.snapshot().current.song.id, 2);
        assert.deepEqual(player.snapshot().queue.map((entry) => entry.song.id), [3]);
    });

    test("skipping with nothing playing is a user error", async () => {
        const { player } = build();
        await assert.rejects(() => player.skip(), UserError);
    });

    test("a stale source failing after a skip does not skip a second track", async () => {
        // Regression: FFmpeg for track 1 reports its failure *after* the user
        // already skipped to track 2. Without a staleness guard that error
        // advanced the queue again, silently eating a track nobody heard fail.
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        await enqueue(player, channel, 3);

        const firstSource = createSourceFn.created[0];
        await player.skip();
        assert.equal(player.snapshot().current.song.id, 2);

        firstSource.options.onError(new Error("late ffmpeg failure"));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(player.snapshot().current.song.id, 2, "track 2 must still be playing");
        assert.deepEqual(player.snapshot().queue.map((entry) => entry.song.id), [3]);
    });

    test("a stale source failing after a seek does not skip the track", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);

        const before = createSourceFn.last();
        await player.seek(30);

        before.options.onError(new Error("killed by the seek"));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(player.snapshot().current.song.id, 1, "seeking must not lose the track");
    });
});

describe("pause, resume, volume", () => {
    test("pause and resume toggle and are idempotent", async () => {
        const { player, channel } = build();
        await enqueue(player, channel, 1);

        assert.equal(player.pause().changed, true);
        assert.equal(player.pause().changed, false, "pausing twice is a statement, not an error");
        assert.equal(player.resume().changed, true);
        assert.equal(player.resume().changed, false);
    });

    test("pausing with nothing playing is a user error", () => {
        const { player } = build();
        assert.throws(() => player.pause(), UserError);
    });

    test("volume applies to the live resource and clamps to 0-200", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);

        assert.equal(player.setVolume(50), 50);
        assert.equal(createSourceFn.last().resource.volume.value, 0.5);
        assert.equal(player.setVolume(500), 200);
        assert.equal(player.setVolume(-5), 0);
    });

    test("volume survives a track change", async () => {
        const { player, voice, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        player.setVolume(30);

        voice.lastPlayer.finishTrack();
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(createSourceFn.last().resource.volume.value, 0.3);
    });
});

describe("seek", () => {
    test("restarts the source at the requested offset", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        const first = createSourceFn.last();

        await player.seek(90);

        assert.equal(first.destroyed, true);
        assert.equal(createSourceFn.last().options.seekSeconds, 90);
        assert.equal(createSourceFn.created.length, 2);
    });

    test("elapsed time accounts for the seek offset", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        await player.seek(60);
        createSourceFn.last().advance(5_000);
        assert.equal(player.snapshot().elapsedSeconds, 65);
    });

    test("refuses to seek past the end of the track", async () => {
        const { player, channel } = build();
        await enqueue(player, channel, 1); // 200 seconds
        await assert.rejects(() => player.seek(500), UserError);
    });

    test("refuses with nothing playing", async () => {
        const { player } = build();
        await assert.rejects(() => player.seek(10), UserError);
    });
});

describe("queue editing", () => {
    test("remove, move, and clear operate on the queue, not the current track", async () => {
        const { player, channel } = build();
        await enqueue(player, channel, 1); // becomes current
        for (const id of [2, 3, 4]) await enqueue(player, channel, id);

        assert.equal(player.removeAt(1).removed.song.id, 2);
        assert.deepEqual(player.snapshot().queue.map((entry) => entry.song.id), [3, 4]);

        player.moveItem(2, 1);
        assert.deepEqual(player.snapshot().queue.map((entry) => entry.song.id), [4, 3]);

        assert.equal(player.clearQueue().removed, 2);
        assert.equal(player.snapshot().current.song.id, 1, "clear must not stop the current track");
    });

    test("out-of-range edits surface as user errors", async () => {
        const { player, channel } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        assert.throws(() => player.removeAt(99), UserError);
        assert.throws(() => player.moveItem(1, 99), UserError);
    });

    test("shuffle needs at least two queued tracks", async () => {
        const { player, channel } = build();
        await enqueue(player, channel, 1);
        assert.throws(() => player.shuffleQueue(), UserError);
    });
});

describe("radio mode", () => {
    const streamUrl = "https://juicewrldapi.com/juicewrld/radio/stream.mp3";

    test("suspends the queue rather than destroying it", async () => {
        const { player, channel } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        await enqueue(player, channel, 3);

        await player.startRadio({ channel, streamUrl });

        const state = player.snapshot();
        assert.equal(state.radioMode, true);
        assert.equal(state.queueLength, 0, "the live queue is empty while the station plays");
        assert.equal(state.suspendedQueueLength, 2, "but the suspended queue is intact");
    });

    test("stopping the station resumes the track that was interrupted", async () => {
        const { player, channel } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);

        await player.startRadio({ channel, streamUrl });
        const { resumed } = await player.stopRadio();

        assert.equal(resumed.song.id, 1, "back to exactly where it was");
        assert.equal(player.snapshot().radioMode, false);
        assert.equal(player.snapshot().queueLength, 1);
    });

    test("resuming picks the track up where it was interrupted, not from zero", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        createSourceFn.last().advance(45_000); // 45 seconds in

        await player.startRadio({ channel, streamUrl });
        const { resumedAtSeconds } = await player.stopRadio();

        assert.equal(resumedAtSeconds, 45);
        assert.equal(createSourceFn.last().options.seekSeconds, 45, "the resumed source seeks to the mark");
    });

    test("streams the URL it was given", async () => {
        const { player, channel, createSourceFn } = build();
        await player.startRadio({ channel, streamUrl });
        assert.equal(createSourceFn.last().options.url, streamUrl);
        // A live stream is never seeked, so no offset is requested at all.
        assert.ok(!createSourceFn.last().options.seekSeconds);
    });

    test("refuses seek, loop, skip, and queue edits with an explanation", async () => {
        const { player, channel } = build();
        await player.startRadio({ channel, streamUrl });

        await assert.rejects(() => player.seek(30), (error) => {
            assert.match(error.userMessage, /live stream/i);
            return true;
        });
        await assert.rejects(() => player.skip(), /live stream/i);
        assert.throws(() => player.setLoop("track"), /live stream/i);
        assert.throws(() => player.cycleLoop(), /live stream/i);
        assert.throws(() => player.removeAt(1), /suspended/i);
        assert.throws(() => player.clearQueue(), /suspended/i);
    });

    test("pause and volume remain valid in radio mode", async () => {
        const { player, channel, createSourceFn } = build();
        await player.startRadio({ channel, streamUrl });

        assert.equal(player.pause().changed, true);
        assert.equal(player.resume().changed, true);
        assert.equal(player.setVolume(60), 60);
        assert.equal(createSourceFn.last().resource.volume.value, 0.6);
    });

    test("enqueueing while the station plays is refused with a way out", async () => {
        const { player, channel } = build();
        await player.startRadio({ channel, streamUrl });
        await assert.rejects(() => enqueue(player, channel, 5), (error) => {
            assert.match(error.userMessage, /radio stop/);
            return true;
        });
    });

    test("stopping the station when it is not playing is a user error", async () => {
        const { player } = build();
        await assert.rejects(() => player.stopRadio(), UserError);
    });
});

describe("endless random mode", () => {
    test("starts immediately and maintains an eight-track look-ahead", async () => {
        const { player, channel } = build();
        const fetchSongs = endlessFetcher();

        const result = await player.startRandom({ channel, requesterId: "u1", fetchSongs });
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(result.changed, true);
        assert.equal(player.snapshot().current.song.id, 100);
        assert.equal(player.snapshot().randomMode, true);
        assert.equal(player.snapshot().randomUpcomingLength, 8);
    });

    test("keeps advancing through random tracks after the visible queue is empty", async () => {
        const { player, channel } = build();
        const fetchSongs = endlessFetcher();
        await player.startRandom({ channel, requesterId: "u1", fetchSongs });

        const heard = [player.snapshot().current.song.id];
        for (let index = 0; index < 12; index += 1) {
            const { next } = await player.skip();
            heard.push(next.song.id);
        }

        assert.equal(new Set(heard).size, heard.length, "the recent window must not repeat");
        assert.equal(player.snapshot().randomMode, true, "shuffle remains active until explicitly stopped");
        assert.equal(player.snapshot().current.requesterId, "u1");
    });

    test("suspends and restores the prior track, position, queue, and loop mode", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);
        player.setLoop("queue");
        createSourceFn.last().advance(45_000);

        await player.startRandom({ channel, requesterId: "u1", fetchSongs: endlessFetcher() });
        assert.equal(player.snapshot().current.song.id, 100);
        assert.equal(player.snapshot().suspendedQueueLength, 1);

        const result = await player.stopRandom();
        assert.equal(result.resumed.song.id, 1);
        assert.equal(result.resumedAtSeconds, 45);
        assert.equal(player.snapshot().queue.at(0).song.id, 2);
        assert.equal(player.snapshot().loop, "queue");
        assert.equal(createSourceFn.last().options.seekSeconds, 45);
    });

    test("does not interrupt existing playback when the archive returns no random track", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        const original = createSourceFn.last();

        await assert.rejects(
            () => player.startRandom({ channel, requesterId: "u1", fetchSongs: async () => [] }),
            /could not find a random playable track/i
        );

        assert.equal(player.snapshot().current.song.id, 1);
        assert.equal(player.snapshot().randomMode, false);
        assert.equal(original.destroyed, false);
    });

    test("queue mutations and radio explain how to leave random mode", async () => {
        const { player, channel } = build();
        await player.startRandom({ channel, requesterId: "u1", fetchSongs: endlessFetcher() });

        await assert.rejects(() => enqueue(player, channel, 5), /random stop/i);
        assert.throws(() => player.setLoop("track"), /random stop/i);
        assert.throws(() => player.clearQueue(), /suspended/i);
        await assert.rejects(
            () => player.startRadio({ channel, streamUrl: "https://example.com/radio.mp3" }),
            /random stop/i
        );
    });
});

describe("concurrency", () => {
    test("two simultaneous play commands produce one join and two queue entries in order", async () => {
        // The per-guild lock is what stops a racing pair of commands from
        // creating two connections and interleaving their resources.
        const { player, voice, channel, createSourceFn } = build();

        const [first, second] = await Promise.all([enqueue(player, channel, 1), enqueue(player, channel, 2)]);

        assert.equal(voice.connections.length, 1, "exactly one join");
        assert.equal(createSourceFn.created.length, 1, "exactly one source started");
        assert.equal(first.started, true);
        assert.equal(second.started, false);
        assert.equal(second.position, 1);
        assert.equal(player.snapshot().current.song.id, 1, "deterministic order");
    });

    test("many concurrent enqueues all land, exactly once each", async () => {
        const { player, voice, channel } = build();
        const ids = [1, 2, 3, 4, 5, 6];

        await Promise.all(ids.map((id) => enqueue(player, channel, id)));

        const state = player.snapshot();
        const landed = [state.current.song.id, ...state.queue.map((entry) => entry.song.id)];
        assert.deepEqual([...landed].sort((a, b) => a - b), ids);
        assert.equal(voice.connections.length, 1);
    });
});

describe("teardown", () => {
    test("destroy tears down the source and the connection and clears state", async () => {
        const { player, voice, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        await enqueue(player, channel, 2);

        player.destroy("test");

        assert.equal(player.destroyed, true);
        assert.equal(createSourceFn.last().destroyed, true);
        assert.equal(voice.lastConnection.destroyed, true);
        assert.equal(player.snapshot().queueLength, 0);
        assert.equal(player.snapshot().current, null);
    });

    test("destroy is idempotent and notifies once", async () => {
        const voice = fakeVoice();
        const destroyed = [];
        const player = createGuildPlayer({
            guildId: "g1",
            config: testConfig(),
            logger: silentLogger(),
            ffmpegPath: "ffmpeg",
            voice,
            createSourceFn: fakeSourceFactory(),
            onDestroy: (id, reason) => destroyed.push({ id, reason }),
        });

        player.destroy("first");
        player.destroy("second");
        assert.deepEqual(destroyed, [{ id: "g1", reason: "first" }]);
    });

    test("stop reports whether anything was playing", async () => {
        const { player, channel } = build();
        await enqueue(player, channel, 1);
        assert.equal((await player.stop()).wasPlaying, true);
    });

    test("events fire on destroy so the registry can react", async () => {
        const { player } = build();
        let seen = null;
        player.events.on("destroyed", (reason) => {
            seen = reason;
        });
        player.destroy("because");
        assert.equal(seen, "because");
    });
});

describe("channel moves", () => {
    test("following a move updates the channel without stopping playback", async () => {
        const { player, channel, createSourceFn } = build();
        await enqueue(player, channel, 1);
        const source = createSourceFn.last();

        player.onMovedTo("1040000000000000099");

        assert.equal(player.channelId, "1040000000000000099");
        assert.equal(source.destroyed, false, "a move must not interrupt audio");
        assert.equal(player.snapshot().current.song.id, 1);
    });
});
