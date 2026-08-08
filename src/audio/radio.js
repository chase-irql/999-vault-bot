import { normalizeStation } from "../api/normalize.js";
import { radioEmbed } from "../bot/embeds.js";

/**
 * 999 FM station tracking.
 *
 * **One poller for the whole process**, never one per guild. Five guilds
 * listening is still one request every fifteen seconds, and polling stops
 * entirely when the last guild leaves radio mode. `pollerInstances` is exported
 * so the multi-guild matrix can assert that on a counter rather than by grepping
 * log output.
 *
 * The station reports `elapsed_ms` only when polled, so a progress bar driven
 * straight off it jumps every fifteen seconds and sits still in between. The
 * sample time is stamped on arrival and the position is extrapolated locally,
 * exactly as the desktop client does, so the bar advances smoothly.
 */

/** Process-wide count of *running* pollers. Must never exceed 1. */
let pollerInstances = 0;

export function getPollerInstances() {
    return pollerInstances;
}

export function createRadioStation({ api, config, logger, clock = Date }) {
    const log = logger.child({ module: "radio" });

    const listeners = new Set();
    let timer = null;
    let station = null;
    let sampledAt = 0;
    let lastTrackKey = "";
    let inFlight = null;
    const trackChangeHandlers = new Set();
    /** guildId -> bound editor for that guild's pinned status message. */
    const statusRenderers = new Map();

    /** Last reported position plus real time elapsed since it was sampled. */
    function elapsedMs() {
        if (!station?.nowPlaying || !sampledAt) return 0;
        const projected = station.nowPlaying.elapsedMs + (clock.now() - sampledAt);
        const duration = station.nowPlaying.durationMs;
        // Never run past the track's own length; the next poll will correct it.
        return duration ? Math.min(projected, duration) : Math.max(0, projected);
    }

    function record(raw) {
        station = normalizeStation(raw, { apiBase: config.apiBaseUrl });
        sampledAt = clock.now();

        const key = `${station.nowPlaying?.title ?? ""}|${station.nowPlaying?.album ?? ""}`;
        if (key !== lastTrackKey) {
            const previous = lastTrackKey;
            lastTrackKey = key;
            // Edit the existing status message rather than posting a new one per
            // track — a station that changes song every three minutes would
            // otherwise flood the channel.
            if (previous) {
                for (const handler of trackChangeHandlers) {
                    try {
                        handler(station);
                    } catch (error) {
                        log.error("track change handler failed", { error });
                    }
                }
                for (const [guildId, edit] of statusRenderers) {
                    // Fire and forget: a failed edit (message deleted, missing
                    // permission) must not stop the other guilds updating.
                    Promise.resolve(edit(buildEmbedPayload()))
                        .then(() => log.debug("station status edited in place", { guildId }))
                        .catch((error) => {
                            log.warn("could not edit station status, dropping renderer", { guildId, error });
                            statusRenderers.delete(guildId);
                        });
                }
            }
        }
        return station;
    }

    function buildEmbedPayload() {
        if (!station) {
            return { embeds: [radioEmbed({ station: null, elapsedMs: 0, degraded: true, reason: "No station status yet." })] };
        }
        return {
            embeds: [
                radioEmbed({
                    station,
                    elapsedMs: elapsedMs(),
                    degraded: station.degraded,
                    reason: station.degraded ? degradedReason(station) : "",
                }),
            ],
        };
    }

    async function poll() {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            try {
                return record(await api.radioLive());
            } catch (error) {
                // A failed poll degrades the embed; it does not stop the audio,
                // which is a separate stream.
                log.warn("station poll failed", { error });
                return station;
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    }

    function startPolling() {
        if (timer) return;
        timer = setInterval(() => void poll(), config.radioPollMs);
        timer.unref?.();
        pollerInstances += 1;
        log.info("station poller started", { intervalMs: config.radioPollMs, instances: pollerInstances });
    }

    function stopPolling() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
        pollerInstances = Math.max(0, pollerInstances - 1);
        log.info("station poller stopped", { instances: pollerInstances });
    }

    return {
        /** Registers a guild as listening; starts the shared poller if it is the first. */
        async subscribe(guildId) {
            const first = listeners.size === 0;
            listeners.add(guildId);
            if (first) startPolling();
            // Always refresh on subscribe so a joining guild gets a current
            // stream URL rather than a stale one.
            await poll();
            return station;
        },

        /** Unregisters a guild; stops the poller when the last one leaves. */
        unsubscribe(guildId) {
            listeners.delete(guildId);
            if (listeners.size === 0) {
                stopPolling();
                lastTrackKey = "";
            }
        },

        onTrackChange(handler) {
            trackChangeHandlers.add(handler);
            return () => trackChangeHandlers.delete(handler);
        },

        /**
         * Registers a guild's status message so a track change edits it in place
         * instead of posting a new message every three minutes. `edit` is a
         * bound callback supplied by the command, so nothing here holds a
         * discord.js object.
         */
        registerStatusMessage(guildId, edit) {
            statusRenderers.set(guildId, edit);
            return () => statusRenderers.delete(guildId);
        },

        clearStatusMessage(guildId) {
            statusRenderers.delete(guildId);
        },

        /** Current station state, refreshing first if nothing has been sampled yet. */
        async fetch() {
            if (!station) await poll();
            return station;
        },

        snapshot: () => station,
        elapsedMs,

        /** HTTPS stream URL, upgraded from the cleartext one the API reports. */
        streamUrl() {
            return station?.streamUrl ?? `${config.apiBaseUrl}/radio/stream.mp3`;
        },

        /** The embed alone, for callers composing their own payload. */
        buildEmbed: () => buildEmbedPayload().embeds[0],

        /** A ready-to-send reply payload. */
        buildEmbedPayload,

        get listenerCount() {
            return listeners.size;
        },
        get polling() {
            return timer !== null;
        },

        stop() {
            listeners.clear();
            trackChangeHandlers.clear();
            stopPolling();
        },
    };
}

/** Says which specific signal made the station untrustworthy, not just "offline". */
export function degradedReason(station) {
    if (!station.isLive) return "The station reports that it is not live right now.";
    if (station.state !== "playing") return `The station state is "${station.state}" rather than playing.`;
    if (station.staleSeconds !== null && station.staleSeconds > 60) {
        return `The station last reported ${Math.round(station.staleSeconds)} seconds ago, so this may be out of date.`;
    }
    return "The station status is incomplete.";
}
