import { UserError } from "../../core/errors.js";
import { infoEmbed, successEmbed } from "../embeds.js";
import { requireActivePlayer, requireVoiceChannel } from "./helpers.js";

/** Desktop-style endless random listening with a hidden eight-track look-ahead. */
export default {
    name: "random",
    aliases: ["endless"],
    category: "Playback",
    description: "Play an endless, completely random archive shuffle.",
    usage: "{prefix}random [stop]",
    guildOnly: true,
    notes:
        "Starting endless shuffle suspends your current track and queue instead of clearing them. " +
        "`random stop` restores the track at the position where it was interrupted.",
    async execute(ctx) {
        const option = ctx.args[0]?.toLowerCase();
        if (option === "stop") {
            const { resumed } = await requireActivePlayer(ctx).stopRandom();
            return ctx.reply({
                embeds: [
                    successEmbed(
                        "Endless shuffle stopped",
                        resumed
                            ? `Back to your queue — resuming **${resumed.song.title}**.`
                            : "Your queue was empty, so nothing resumed."
                    ),
                ],
            });
        }
        if (option) {
            throw new UserError(`Unknown option. Use \`${ctx.deps.config.prefix}random\` or \`${ctx.deps.config.prefix}random stop\`.`);
        }

        const channel = requireVoiceChannel(ctx);
        await ctx.defer();
        const player = ctx.deps.players.ensure(ctx.guildId);
        const result = await player.startRandom({
            channel,
            requesterId: ctx.userId,
            fetchSongs: (count, options) => ctx.deps.archive.randomSongs(count, options),
        });

        if (!result.changed) {
            return ctx.editReply({
                embeds: [infoEmbed("Endless shuffle is already playing", "Skip whenever you want another random track.")],
            });
        }
        return ctx.editReply({
            embeds: [
                successEmbed(
                    "Endless shuffle",
                    `Now playing **${result.current.song.title}**. Eight random tracks stay ready ahead; use \`${ctx.deps.config.prefix}random stop\` to restore your queue.`
                ),
            ],
        });
    },
};
