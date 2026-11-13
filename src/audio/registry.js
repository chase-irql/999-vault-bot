import { createGuildPlayer } from "./guild-player.js";

/**
 * `Map<guildId, GuildPlayer>` — the only module that constructs or destroys a
 * player.
 *
 * Centralising creation is what makes guild isolation checkable: there is
 * exactly one place a player can come from, so a stray second player for a guild
 * is impossible rather than merely unlikely, and destroying one guild's player
 * provably cannot reach another's.
 */

export function createPlayerRegistry({
    config,
    logger,
    ffmpegPath,
    youtube,
    clock = Date,
    rng = Math.random,
    // Passed straight through so a test registry builds players with fake voice
    // primitives; production leaves both undefined and gets the real ones.
    voice = undefined,
    createSourceFn = undefined,
}) {
    const players = new Map();
    const log = logger.child({ module: "registry" });

    function get(guildId) {
        return players.get(guildId) ?? null;
    }

    /** Returns the guild's player, creating one only if it does not exist. */
    function ensure(guildId) {
        const existing = players.get(guildId);
        if (existing && !existing.destroyed) return existing;

        const player = createGuildPlayer({
            guildId,
            config,
            logger,
            ffmpegPath,
            youtube,
            clock,
            rng,
            ...(voice ? { voice } : {}),
            ...(createSourceFn ? { createSourceFn } : {}),
            onDestroy: (id, reason) => {
                // Only ever removes its own entry — never touches another guild.
                if (players.get(id)?.destroyed !== false) players.delete(id);
                log.debug("player removed from registry", { guildId: id, reason, remaining: players.size });
            },
        });
        players.set(guildId, player);
        log.info("player created", { guildId, active: players.size });
        return player;
    }

    function destroy(guildId, reason = "destroyed") {
        const player = players.get(guildId);
        if (!player) return false;
        player.destroy(reason);
        players.delete(guildId);
        return true;
    }

    function destroyAll(reason = "shutdown") {
        for (const guildId of [...players.keys()]) destroy(guildId, reason);
    }

    return {
        get,
        ensure,
        destroy,
        destroyAll,
        has: (guildId) => players.has(guildId),
        list: () => [...players.values()],
        get size() {
            return players.size;
        },
        /** How many guilds are relaying the station — used by `stats`. */
        get radioCount() {
            let count = 0;
            for (const player of players.values()) if (player.radioMode) count += 1;
            return count;
        },
    };
}
