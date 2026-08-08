import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createPlayerRegistry } from "../src/audio/registry.js";
import { silentLogger, testConfig } from "./helpers/context.mjs";
import { fakeChannel, fakeSourceFactory, fakeVoice, song } from "./helpers/voice.mjs";

/**
 * Multi-guild isolation, offline.
 *
 * The live matrix in scripts/verify-voice.mjs proves this against two real
 * guilds; this suite proves the same properties against the structure, so a
 * regression fails a commit rather than waiting for someone to notice audio
 * changing in the wrong server.
 */

const GUILD_A = "1040000000000000001";
const GUILD_B = "1040000000000000002";

function build() {
    const voice = fakeVoice();
    const createSourceFn = fakeSourceFactory();
    const players = createPlayerRegistry({
        config: testConfig(),
        logger: silentLogger(),
        ffmpegPath: "C:/fake/ffmpeg.exe",
        rng: () => 0,
        voice,
        createSourceFn,
    });
    return { players, voice, createSourceFn };
}

const channelFor = (guildId) => {
    const channel = fakeChannel({ id: `${guildId}-voice` });
    channel.guild.id = guildId;
    return channel;
};

const enqueue = (player, guildId, id) =>
    player.enqueue(song({ id, title: `Track ${id}` }), { requesterId: "u", channel: channelFor(guildId) });

describe("registry lifecycle", () => {
    test("ensure creates one player per guild and reuses it", () => {
        const { players } = build();
        const first = players.ensure(GUILD_A);
        const second = players.ensure(GUILD_A);
        assert.equal(first, second, "a guild must never get two players");
        assert.equal(players.size, 1);
    });

    test("get never creates", () => {
        const { players } = build();
        assert.equal(players.get(GUILD_A), null);
        assert.equal(players.size, 0);
    });

    test("a destroyed player is replaced rather than resurrected", () => {
        const { players } = build();
        const first = players.ensure(GUILD_A);
        first.destroy("test");
        const second = players.ensure(GUILD_A);
        assert.notEqual(first, second);
        assert.equal(second.destroyed, false);
    });

    test("destroying removes only that guild's entry", () => {
        const { players } = build();
        players.ensure(GUILD_A);
        players.ensure(GUILD_B);
        players.destroy(GUILD_A, "test");
        assert.equal(players.has(GUILD_A), false);
        assert.equal(players.has(GUILD_B), true);
        assert.equal(players.size, 1);
    });

    test("destroyAll empties the registry", () => {
        const { players } = build();
        players.ensure(GUILD_A);
        players.ensure(GUILD_B);
        players.destroyAll("shutdown");
        assert.equal(players.size, 0);
    });

    test("destroying an unknown guild is a no-op", () => {
        const { players } = build();
        assert.equal(players.destroy("1040000000000000009"), false);
    });
});

describe("guild isolation", () => {
    test("each guild gets its own connection and its own source", async () => {
        const { players, voice, createSourceFn } = build();
        await enqueue(players.ensure(GUILD_A), GUILD_A, 1);
        await enqueue(players.ensure(GUILD_B), GUILD_B, 2);

        assert.equal(voice.connections.length, 2);
        assert.equal(createSourceFn.created.length, 2);
        assert.notEqual(voice.connections[0], voice.connections[1]);
    });

    test("guild A's skip, volume, loop and stop leave guild B untouched", async () => {
        const { players } = build();
        const a = players.ensure(GUILD_A);
        const b = players.ensure(GUILD_B);

        await enqueue(a, GUILD_A, 1);
        await enqueue(a, GUILD_A, 2);
        await enqueue(b, GUILD_B, 10);
        await enqueue(b, GUILD_B, 11);

        const before = b.snapshot();

        await a.skip();
        a.setVolume(25);
        a.setLoop("queue");

        const after = b.snapshot();
        assert.equal(after.current.song.id, before.current.song.id, "B's current track must not move");
        assert.equal(after.volume, before.volume, "B's volume must not change");
        assert.equal(after.loop, "off", "B's loop mode must not change");
        assert.deepEqual(
            after.queue.map((entry) => entry.song.id),
            before.queue.map((entry) => entry.song.id),
            "B's queue must be identical"
        );
    });

    test("destroying guild A leaves guild B playing", async () => {
        const { players } = build();
        const a = players.ensure(GUILD_A);
        const b = players.ensure(GUILD_B);
        await enqueue(a, GUILD_A, 1);
        await enqueue(b, GUILD_B, 10);

        players.destroy(GUILD_A, "test");

        assert.equal(a.destroyed, true);
        assert.equal(b.destroyed, false);
        assert.equal(b.snapshot().current.song.id, 10);
        assert.equal(players.size, 1);
    });

    test("one guild in radio mode and one in queue mode coexist", async () => {
        const { players } = build();
        const a = players.ensure(GUILD_A);
        const b = players.ensure(GUILD_B);

        await a.startRadio({
            channel: channelFor(GUILD_A),
            streamUrl: "https://juicewrldapi.com/juicewrld/radio/stream.mp3",
        });
        await enqueue(b, GUILD_B, 10);

        assert.equal(a.radioMode, true);
        assert.equal(b.radioMode, false);
        assert.equal(b.snapshot().current.song.id, 10);
        assert.equal(players.radioCount, 1, "only one guild is on the station");
    });

    test("radioCount tracks guilds accurately as they come and go", async () => {
        const { players } = build();
        const streamUrl = "https://juicewrldapi.com/juicewrld/radio/stream.mp3";
        const a = players.ensure(GUILD_A);
        const b = players.ensure(GUILD_B);

        assert.equal(players.radioCount, 0);
        await a.startRadio({ channel: channelFor(GUILD_A), streamUrl });
        await b.startRadio({ channel: channelFor(GUILD_B), streamUrl });
        assert.equal(players.radioCount, 2);

        await a.stopRadio();
        assert.equal(players.radioCount, 1);
    });

    test("concurrent commands across guilds do not interleave state", async () => {
        const { players, voice } = build();
        const a = players.ensure(GUILD_A);
        const b = players.ensure(GUILD_B);

        await Promise.all([
            enqueue(a, GUILD_A, 1),
            enqueue(b, GUILD_B, 10),
            enqueue(a, GUILD_A, 2),
            enqueue(b, GUILD_B, 11),
        ]);

        assert.equal(a.snapshot().current.song.id, 1);
        assert.equal(b.snapshot().current.song.id, 10);
        assert.deepEqual(a.snapshot().queue.map((e) => e.song.id), [2]);
        assert.deepEqual(b.snapshot().queue.map((e) => e.song.id), [11]);
        assert.equal(voice.connections.length, 2, "one join per guild, not per command");
    });
});
