/**
 * Open disambiguation prompts.
 *
 * Keyed by `guildId:channelId:userId`, deliberately: two people prompting in the
 * same channel must not be able to answer each other's question. That is a real
 * failure mode — user 2 typing "1" while user 1 has a prompt open would
 * otherwise resolve user 1's prompt with user 2's intent.
 *
 * Each prompt owns exactly one timer and one entry, both removed on resolve or
 * expiry, so nothing accumulates.
 */

export const DEFAULT_TIMEOUT_MS = 60_000;

const keyOf = (guildId, channelId, userId) => `${guildId}:${channelId}:${userId}`;

export function createPendingResolutions({ logger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const entries = new Map();
    const log = logger?.child?.({ module: "pending" }) ?? logger;

    function close(key) {
        const entry = entries.get(key);
        if (!entry) return null;
        clearTimeout(entry.timer);
        entries.delete(key);
        return entry;
    }

    return {
        /**
         * Opens a prompt. Replaces the same user's previous prompt in the same
         * channel rather than stacking one on top of it.
         *
         * @returns {() => void} cancel
         */
        open({ guildId, channelId, userId, candidates, onChoose, onExpire = null }) {
            const key = keyOf(guildId, channelId, userId);
            close(key);

            const timer = setTimeout(() => {
                entries.delete(key);
                log?.debug?.("disambiguation expired", { guildId, userId, choices: candidates.length });
                onExpire?.();
            }, timeoutMs);
            timer.unref?.();

            entries.set(key, { candidates, onChoose, timer });
            return () => close(key);
        },

        /**
         * Offers a message to any open prompt. Returns true when it was consumed,
         * so the router does not also try to parse it as a command.
         */
        async handleMessage(message) {
            const key = keyOf(message.guildId, message.channelId, message.author.id);
            const entry = entries.get(key);
            if (!entry) return false;

            const choice = Number(String(message.content ?? "").trim());
            if (!Number.isInteger(choice) || choice < 1 || choice > entry.candidates.length) return false;

            close(key);
            try {
                await entry.onChoose(entry.candidates[choice - 1], message);
            } catch (error) {
                log?.error?.("disambiguation choice failed", { error });
            }
            return true;
        },

        has: (guildId, channelId, userId) => entries.has(keyOf(guildId, channelId, userId)),
        cancel: (guildId, channelId, userId) => Boolean(close(keyOf(guildId, channelId, userId))),

        get size() {
            return entries.size;
        },

        /** Shutdown: drop every timer so nothing keeps the process alive. */
        clear() {
            for (const key of [...entries.keys()]) close(key);
        },
    };
}
