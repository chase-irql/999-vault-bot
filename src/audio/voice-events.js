/**
 * Translates raw `voiceStateUpdate` events into the two things a player cares
 * about: it was moved, or it is alone.
 *
 * Kept out of `guild-player.js` so the player stays testable without a gateway —
 * the player exposes `onMovedTo` and `onAloneChanged`, and this module is the
 * only thing that knows what a VoiceState is.
 */

export function createVoiceEvents({ players, logger, clientUserId }) {
    const log = logger.child({ module: "voice-events" });

    /** Humans, excluding this bot and any other bot, in a channel. */
    function humanCount(channel) {
        if (!channel?.members) return 0;
        let count = 0;
        for (const member of channel.members.values()) {
            if (!member.user?.bot) count += 1;
        }
        return count;
    }

    function refreshAlone(guildId, channel) {
        const player = players.get(guildId);
        if (!player || player.destroyed) return;
        const alone = humanCount(channel) === 0;
        player.onAloneChanged(alone);
        if (alone) log.debug("bot is alone in the channel, idle timer armed", { guildId });
    }

    return {
        onVoiceStateUpdate(oldState, newState) {
            const guildId = newState.guild?.id ?? oldState.guild?.id;
            if (!guildId) return;
            const player = players.get(guildId);
            if (!player || player.destroyed) return;

            // The bot itself moved, or was dragged, to another channel.
            if (newState.id === clientUserId()) {
                if (newState.channelId && newState.channelId !== oldState.channelId) {
                    // Follow it and keep playing rather than stopping.
                    player.onMovedTo(newState.channelId);
                    refreshAlone(guildId, newState.channel);
                    return;
                }
                if (!newState.channelId) {
                    log.info("bot was disconnected from voice", { guildId });
                    players.destroy(guildId, "removed from voice channel");
                    return;
                }
            }

            // Someone else came or went; only the bot's own channel matters.
            const watched = player.channelId;
            if (!watched) return;
            if (oldState.channelId !== watched && newState.channelId !== watched) return;

            const channel = newState.channelId === watched ? newState.channel : oldState.channel;
            refreshAlone(guildId, channel);
        },
    };
}
