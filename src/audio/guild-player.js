import {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    createAudioPlayer,
    entersState,
    joinVoiceChannel,
} from "@discordjs/voice";
import { UserError, VoiceError } from "../core/errors.js";
import * as queue from "../core/queue.js";
import { isErr } from "../core/result.js";
import { createSource } from "./source.js";

/**
 * The single state authority for one guild: voice connection, queue, current
 * track, loop mode, volume, and radio mode.
 *
 * Commands call intent methods here and render what comes back. They never touch
 * a VoiceConnection, never build an AudioResource, and never mutate the queue.
 * Because all mutable playback state lives inside one of these, isolation
 * between guilds is a property of the design rather than something to test for
 * and hope about.
 */

const READY_TIMEOUT_MS = 15_000;
const RECONNECT_WINDOW_MS = 5_000;

/** Station reconnect schedule: 2s, 4s, 8s, 16s, 30s. */
const RADIO_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * The voice primitives, injectable so the state machine can be driven offline.
 * Defaults are the real ones; tests pass a fake connection and a fake player and
 * assert on transitions without a gateway.
 */
export const REAL_VOICE = Object.freeze({ joinVoiceChannel, createAudioPlayer, entersState });

export function createGuildPlayer({
    guildId,
    config,
    logger,
    ffmpegPath,
    clock = Date,
    rng = Math.random,
    onDestroy = null,
    voice = REAL_VOICE,
    createSourceFn = createSource,
}) {
    const log = logger.child({ module: "player", guildId });

    let connection = null;
    let channelId = null;
    let source = null;
    let current = null;
    let state = queue.createQueue();
    let volume = config.defaultVolume;
    let status = "idle";
    let seekOffsetSeconds = 0;
    let destroyed = false;

    let radioMode = false;
    let suspendedQueue = null;
    let suspendedCurrent = null;
    /** Where the interrupted track had reached, so resuming does not restart it. */
    let suspendedElapsedSeconds = 0;
    let radioAttempt = 0;
    let radioRetryTimer = null;
    let radioStreamUrl = "";

    let idleTimer = null;
    let bufferingSeen = 0;

    /**
     * Increments on every resource start. A source that fails *after* the player
     * has already moved on (skip, seek, stop) would otherwise skip a second
     * track — one the listener never heard fail.
     */
    let sourceToken = 0;

    // Serializes everything that can start or stop audio. Two `play` commands
    // racing in one guild must produce one join and two queue entries, not two
    // joins and an interleaved resource.
    let lock = Promise.resolve();
    const withLock = (task) => {
        const run = lock.then(task, task);
        lock = run.then(
            () => {},
            () => {}
        );
        return run;
    };

    const player = voice.createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    // --- internals ---------------------------------------------------------

    function clearIdleTimer() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }

    function stopSource() {
        source?.destroy();
        source = null;
    }

    function elapsedSeconds() {
        if (!current || !source) return 0;
        return seekOffsetSeconds + (source.resource?.playbackDuration ?? 0) / 1000;
    }

    function applyVolume() {
        source?.resource?.volume?.setVolume(volume / 100);
    }

    /** Builds and plays a resource for `item`, starting at `seekSeconds`. */
    function startResource(item, seekSeconds = 0) {
        stopSource();
        status = "loading";
        bufferingSeen = 0;
        seekOffsetSeconds = seekSeconds;
        const token = (sourceToken += 1);

        source = createSourceFn({
            ffmpegPath,
            url: item.song.streamUrl,
            seekSeconds,
            logger: log,
            metadata: { guildId, songId: item.song.id },
            onError: (error) => {
                if (token !== sourceToken) return; // stale source; we already moved on
                log.warn("audio source failed", { songId: item.song.id, error });
                // Skip past a track that will not decode rather than sitting on it.
                void withLock(() => advance({ skipping: true, failed: item }));
            },
        });

        applyVolume();
        player.play(source.resource);
        current = item;
    }

    /** Advances the queue honouring loop mode, or goes idle. */
    async function advance({ skipping = false, failed = null } = {}) {
        if (destroyed) return null;

        if (radioMode) {
            // The station has no queue to advance into; a drop is a reconnect.
            return null;
        }

        const finished = failed ?? current;
        const result = queue.advance(state, finished, { skipping });
        state = result.state;

        if (!result.next) {
            current = null;
            status = "idle";
            stopSource();
            scheduleIdleDisconnect();
            return null;
        }

        startResource(result.next);
        return result.next;
    }

    function scheduleIdleDisconnect() {
        clearIdleTimer();
        if (destroyed || !connection) return;
        idleTimer = setTimeout(() => {
            log.info("idle timeout reached, leaving voice", { idleMs: config.idleDisconnectMs });
            destroy("idle timeout");
        }, config.idleDisconnectMs);
        idleTimer.unref?.();
    }

    // --- player events -----------------------------------------------------

    player.on(AudioPlayerStatus.Playing, () => {
        status = "playing";
        clearIdleTimer();
    });

    player.on(AudioPlayerStatus.Paused, () => {
        status = "paused";
    });

    player.on(AudioPlayerStatus.AutoPaused, () => {
        // NoSubscriberBehavior.Pause: nobody is listening. Not an error.
        status = "paused";
    });

    player.on(AudioPlayerStatus.Buffering, () => {
        bufferingSeen += 1;
        if (status === "playing") {
            // Re-entering Buffering during steady-state playback is a defect
            // signal, not normal operation.
            log.warn("buffering during steady-state playback", {
                songId: current?.song?.id,
                path: current?.song?.path,
                occurrences: bufferingSeen,
            });
        }
    });

    player.on(AudioPlayerStatus.Idle, (oldState) => {
        if (destroyed) return;
        if (oldState.status !== AudioPlayerStatus.Playing && oldState.status !== AudioPlayerStatus.Paused) return;

        if (radioMode) {
            void reconnectRadio("stream ended");
            return;
        }
        void withLock(() => advance());
    });

    player.on("error", (error) => {
        log.error("audio player error", { error, songId: current?.song?.id });
        if (radioMode) {
            void reconnectRadio("player error");
            return;
        }
        void withLock(() => advance({ skipping: true }));
    });

    // --- radio -------------------------------------------------------------

    function clearRadioRetry() {
        if (radioRetryTimer) {
            clearTimeout(radioRetryTimer);
            radioRetryTimer = null;
        }
    }

    async function reconnectRadio(reason) {
        if (!radioMode || destroyed) return;
        if (radioAttempt >= RADIO_BACKOFF_MS.length) {
            log.error("station reconnect exhausted", { reason, attempts: radioAttempt });
            radioMode = false;
            restoreQueue();
            events.emit("radio-failed");
            return;
        }
        const delay = RADIO_BACKOFF_MS[radioAttempt];
        radioAttempt += 1;
        log.warn("station stream dropped, reconnecting", { reason, attempt: radioAttempt, delayMs: delay });

        clearRadioRetry();
        radioRetryTimer = setTimeout(() => {
            if (!radioMode || destroyed) return;
            startRadioResource();
        }, delay);
        radioRetryTimer.unref?.();
    }

    function startRadioResource() {
        stopSource();
        status = "loading";
        seekOffsetSeconds = 0;
        const token = (sourceToken += 1);

        source = createSourceFn({
            ffmpegPath,
            url: radioStreamUrl,
            logger: log,
            metadata: { guildId, radio: true },
            onError: (error) => {
                if (token !== sourceToken) return; // superseded by a later reconnect
                log.warn("station source failed", { error });
                void reconnectRadio("source error");
            },
        });
        applyVolume();
        player.play(source.resource);
    }

    function restoreQueue() {
        state = suspendedQueue ?? queue.createQueue(state.loop);
        current = null;
        suspendedQueue = null;
        const resume = suspendedCurrent;
        suspendedCurrent = null;
        return resume;
    }

    // Minimal emitter so the registry can react without importing the player.
    const listeners = new Map();
    const events = {
        on(name, handler) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(handler);
        },
        emit(name, payload) {
            for (const handler of listeners.get(name) ?? []) {
                try {
                    handler(payload);
                } catch (error) {
                    log.error("player event handler failed", { event: name, error });
                }
            }
        },
    };

    // --- connection --------------------------------------------------------

    function assertPermissions(channel) {
        const me = channel.guild?.members?.me;
        const permissions = me ? channel.permissionsFor(me) : null;
        if (!permissions) return;
        const missing = ["Connect", "Speak"].filter((flag) => !permissions.has(flag));
        if (missing.length > 0) {
            throw new VoiceError(
                `I need the ${missing.join(" and ")} permission${missing.length > 1 ? "s" : ""} in ` +
                    `**${channel.name}**.`,
                { channelId: channel.id, missing }
            );
        }
    }

    function wireConnection() {
        connection.on(VoiceConnectionStatus.Disconnected, () => {
            void (async () => {
                try {
                    // A disconnect is usually a region change or a move, both of
                    // which resolve themselves within a few seconds.
                    await Promise.race([
                        voice.entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_WINDOW_MS),
                        voice.entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_WINDOW_MS),
                    ]);
                    log.info("voice reconnecting after disconnect");
                } catch {
                    log.warn("voice disconnect did not recover, destroying player");
                    destroy("voice disconnected");
                }
            })();
        });

        connection.on("error", (error) => log.error("voice connection error", { error }));
    }

    async function connect(channel) {
        if (!channel) {
            throw new UserError("Join a voice channel first, then run that again.");
        }
        assertPermissions(channel);

        if (connection && channelId === channel.id) return connection;

        // Already connected elsewhere: rejoining moves the bot rather than
        // stacking a second connection.
        connection = voice.joinVoiceChannel({
            channelId: channel.id,
            guildId,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false,
        });
        channelId = channel.id;
        wireConnection();
        connection.subscribe(player);

        try {
            await voice.entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
        } catch (error) {
            connection.destroy();
            connection = null;
            channelId = null;
            throw new VoiceError("I could not connect to that voice channel.", { cause: error });
        }
        log.info("voice ready", { channelId });
        return connection;
    }

    // --- public API --------------------------------------------------------

    function snapshot() {
        return {
            guildId,
            channelId,
            status,
            radioMode,
            current,
            elapsedSeconds: elapsedSeconds(),
            queue: state.items,
            queueLength: state.items.length,
            loop: state.loop,
            volume,
            totalDurationSeconds: queue.totalDuration(state, current),
            suspendedQueueLength: suspendedQueue?.items.length ?? 0,
        };
    }

    function destroy(reason = "destroyed") {
        if (destroyed) return;
        destroyed = true;
        clearIdleTimer();
        clearRadioRetry();
        stopSource();
        try {
            player.stop(true);
        } catch {
            // Already stopped.
        }
        try {
            connection?.destroy();
        } catch {
            // Already destroyed.
        }
        connection = null;
        channelId = null;
        current = null;
        state = queue.createQueue();
        radioMode = false;
        log.info("player destroyed", { reason });
        onDestroy?.(guildId, reason);
        events.emit("destroyed", reason);
    }

    return {
        guildId,
        events,
        snapshot,
        destroy,

        get destroyed() {
            return destroyed;
        },
        get radioMode() {
            return radioMode;
        },
        get channelId() {
            return channelId;
        },

        /** Join or move to `channel`. Idempotent for the channel already joined. */
        join(channel) {
            return withLock(async () => {
                await connect(channel);
                return snapshot();
            });
        },

        /**
         * Adds a song and starts playback if nothing is playing.
         * @returns {Promise<{ position: number, started: boolean }>}
         */
        enqueue(song, { requesterId, channel, next = false }) {
            return withLock(async () => {
                await connect(channel);
                if (radioMode) {
                    throw new UserError(
                        "The station is playing. Use `radio stop` to go back to the queue, then add tracks."
                    );
                }

                const item = { song, requesterId };
                const result = next ? queue.enqueueNext(state, item) : queue.enqueue(state, item);
                if (isErr(result)) throw new UserError(result.error);
                state = result.value;

                if (!current) {
                    const { state: nextState, item: head } = queue.dequeue(state);
                    state = nextState;
                    startResource(head);
                    clearIdleTimer();
                    return { position: 0, started: true, snapshot: snapshot() };
                }
                const position = next ? 1 : state.items.length;
                return { position, started: false, snapshot: snapshot() };
            });
        },

        skip() {
            return withLock(async () => {
                if (radioMode) {
                    throw new UserError("The station is a live stream — there is nothing to skip to.");
                }
                if (!current) throw new UserError("Nothing is playing.");
                const skipped = current;
                const next = await advance({ skipping: true });
                return { skipped, next, snapshot: snapshot() };
            });
        },

        stop() {
            return withLock(async () => {
                const wasPlaying = Boolean(current) || radioMode;
                destroy("stop command");
                return { wasPlaying };
            });
        },

        pause() {
            if (!current && !radioMode) throw new UserError("Nothing is playing.");
            if (status === "paused") return { changed: false, status };
            player.pause(true);
            status = "paused";
            return { changed: true, status };
        },

        resume() {
            if (!current && !radioMode) throw new UserError("Nothing is playing.");
            if (status !== "paused") return { changed: false, status };
            player.unpause();
            status = "playing";
            return { changed: true, status };
        },

        seek(seconds) {
            return withLock(async () => {
                if (radioMode) {
                    throw new UserError("999 FM is a live stream. It cannot be seeked.");
                }
                if (!current) throw new UserError("Nothing is playing.");
                const total = current.song.durationSeconds;
                if (Number.isFinite(total) && seconds >= total) {
                    throw new UserError(`That is past the end of the track (${Math.floor(total)}s).`);
                }
                startResource(current, Math.max(0, Math.floor(seconds)));
                return snapshot();
            });
        },

        setVolume(next) {
            volume = Math.min(200, Math.max(0, Math.round(next)));
            applyVolume();
            return volume;
        },

        getVolume: () => volume,

        setLoop(mode) {
            if (radioMode) throw new UserError("Loop does not apply to a live stream.");
            const result = queue.setLoop(state, mode);
            if (isErr(result)) throw new UserError(result.error);
            state = result.value;
            return state.loop;
        },

        cycleLoop() {
            if (radioMode) throw new UserError("Loop does not apply to a live stream.");
            state = queue.cycleLoop(state);
            return state.loop;
        },

        shuffleQueue() {
            if (radioMode) throw new UserError("The station queue is not yours to shuffle.");
            if (queue.size(state) < 2) throw new UserError("There are not enough queued tracks to shuffle.");
            state = queue.shuffle(state, rng);
            return snapshot();
        },

        removeAt(position) {
            if (radioMode) throw new UserError("The queue is suspended while the station is playing.");
            const result = queue.remove(state, position);
            if (isErr(result)) throw new UserError(result.error);
            state = result.value.state;
            return { removed: result.value.item, snapshot: snapshot() };
        },

        moveItem(from, to) {
            if (radioMode) throw new UserError("The queue is suspended while the station is playing.");
            const result = queue.move(state, from, to);
            if (isErr(result)) throw new UserError(result.error);
            state = result.value.state;
            return { moved: result.value.item, snapshot: snapshot() };
        },

        clearQueue() {
            if (radioMode) throw new UserError("The queue is suspended while the station is playing.");
            const removed = queue.size(state);
            state = queue.clear(state);
            return { removed, snapshot: snapshot() };
        },

        queuePage(pageNumber, pageSize = 10) {
            return { ...queue.page(state, pageNumber, pageSize), snapshot: snapshot() };
        },

        /**
         * Enters radio mode. The queue is **suspended**, not destroyed: leaving
         * radio mode puts the listener back where they were.
         */
        startRadio({ channel, streamUrl }) {
            return withLock(async () => {
                await connect(channel);
                if (!radioMode) {
                    suspendedQueue = state;
                    suspendedCurrent = current;
                    // Stamp the position so `radio stop` resumes the track where
                    // it was interrupted rather than restarting it.
                    suspendedElapsedSeconds = Math.floor(elapsedSeconds());
                    state = queue.createQueue(state.loop);
                }
                radioMode = true;
                radioAttempt = 0;
                radioStreamUrl = streamUrl;
                current = null;
                clearIdleTimer();
                startRadioResource();
                return snapshot();
            });
        },

        /** Leaves radio mode and resumes the suspended queue where it stopped. */
        stopRadio() {
            return withLock(async () => {
                if (!radioMode) throw new UserError("The station is not playing.");
                radioMode = false;
                radioAttempt = 0;
                clearRadioRetry();
                stopSource();

                const resumeAt = suspendedElapsedSeconds;
                suspendedElapsedSeconds = 0;
                const resume = restoreQueue();
                if (resume) {
                    startResource(resume, resumeAt);
                    return { resumed: resume, resumedAtSeconds: resumeAt, snapshot: snapshot() };
                }
                const { state: nextState, item } = queue.dequeue(state);
                state = nextState;
                if (item) {
                    startResource(item);
                    return { resumed: item, snapshot: snapshot() };
                }
                status = "idle";
                scheduleIdleDisconnect();
                return { resumed: null, snapshot: snapshot() };
            });
        },

        /** Called by the voice-state watcher when the bot is moved or left alone. */
        onMovedTo(newChannelId) {
            if (!newChannelId || newChannelId === channelId) return;
            log.info("following voice channel move", { from: channelId, to: newChannelId });
            channelId = newChannelId;
        },

        onAloneChanged(alone) {
            if (alone) scheduleIdleDisconnect();
            else clearIdleTimer();
        },

        // Exposed for the voice smoke test's assertions, not for commands.
        get internals() {
            return { player, get connection() {
                return connection;
            }, get source() {
                return source;
            } };
        },
    };
}

export { RADIO_BACKOFF_MS };
