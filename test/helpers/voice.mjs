import { EventEmitter } from "node:events";
import { AudioPlayerStatus } from "@discordjs/voice";

/**
 * Fakes for the voice layer.
 *
 * `@discordjs/voice`'s status constants are plain strings, so a fake player is
 * an EventEmitter that emits the same names. That is enough to drive every
 * transition in GuildPlayer — advance-on-idle, buffering warnings, pause and
 * resume — with no gateway, no UDP socket, and no FFmpeg process.
 */

export function fakeAudioPlayer() {
    const player = new EventEmitter();
    player.state = { status: AudioPlayerStatus.Idle };
    player.played = [];

    player.play = (resource) => {
        player.played.push(resource);
        player.state = { status: AudioPlayerStatus.Playing };
        player.emit(AudioPlayerStatus.Playing, { status: AudioPlayerStatus.Buffering }, player.state);
    };
    player.pause = () => {
        player.state = { status: AudioPlayerStatus.Paused };
        player.emit(AudioPlayerStatus.Paused, {}, player.state);
        return true;
    };
    player.unpause = () => {
        player.state = { status: AudioPlayerStatus.Playing };
        return true;
    };
    player.stop = () => {
        player.state = { status: AudioPlayerStatus.Idle };
        return true;
    };

    /** Simulates a track running out, which is what advances the queue. */
    player.finishTrack = () => {
        const previous = { status: AudioPlayerStatus.Playing };
        player.state = { status: AudioPlayerStatus.Idle };
        player.emit(AudioPlayerStatus.Idle, previous, player.state);
    };

    player.enterBuffering = () => player.emit(AudioPlayerStatus.Buffering, {}, player.state);
    player.fail = (error) => player.emit("error", error);

    return player;
}

export function fakeConnection() {
    const connection = new EventEmitter();
    connection.destroyed = false;
    connection.subscribed = null;
    connection.subscribe = (player) => {
        connection.subscribed = player;
        return { unsubscribe() {} };
    };
    connection.destroy = () => {
        connection.destroyed = true;
    };
    return connection;
}

/** A voice channel with the permissions the player checks for. */
export function fakeChannel({ id = "1040000000000000010", name = "General", permissions = ["Connect", "Speak"] } = {}) {
    return {
        id,
        name,
        guild: {
            id: "1040000000000000001",
            voiceAdapterCreator: () => ({}),
            members: { me: { id: "bot" } },
        },
        permissionsFor: () => ({ has: (flag) => permissions.includes(flag) }),
    };
}

/**
 * Injectable voice primitives.
 * @param {{ readyFails?: boolean }} [options]
 */
export function fakeVoice({ readyFails = false } = {}) {
    const players = [];
    const connections = [];

    return {
        players,
        connections,
        createAudioPlayer() {
            const player = fakeAudioPlayer();
            players.push(player);
            return player;
        },
        joinVoiceChannel(options) {
            const connection = fakeConnection();
            connection.joinConfig = options;
            connections.push(connection);
            return connection;
        },
        async entersState() {
            if (readyFails) throw new Error("never became ready");
            return true;
        },
        /** The player belonging to the most recently created GuildPlayer. */
        get lastPlayer() {
            return players.at(-1);
        },
        get lastConnection() {
            return connections.at(-1);
        },
    };
}

/** A source factory that records calls instead of spawning FFmpeg. */
export function fakeSourceFactory() {
    const created = [];
    const factory = (options) => {
        let playbackDuration = 0;
        const source = {
            options,
            destroyed: false,
            resource: {
                get playbackDuration() {
                    return playbackDuration;
                },
                volume: {
                    value: 1,
                    setVolume(next) {
                        this.value = next;
                    },
                },
            },
            advance(ms) {
                playbackDuration += ms;
            },
            destroy() {
                source.destroyed = true;
            },
        };
        created.push(source);
        return source;
    };
    factory.created = created;
    factory.last = () => created.at(-1);
    return factory;
}

export function song(overrides = {}) {
    return {
        id: 1,
        publicId: 1,
        title: "Track One",
        aliases: [],
        fileNames: [],
        path: "Folder/track.mp3",
        artist: "Juice WRLD",
        album: "",
        durationSeconds: 200,
        category: "released",
        era: { id: 1, name: "GB&GR", timeFrame: "", playCount: 100 },
        imageUrl: "",
        streamUrl: "https://juicewrldapi.com/juicewrld/files/download/?path=Folder%2Ftrack.mp3",
        producers: "",
        engineers: "",
        recordingLocations: "",
        leakType: "",
        ...overrides,
    };
}
