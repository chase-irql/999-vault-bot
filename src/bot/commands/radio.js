import { UserError } from "../../core/errors.js";
import { successEmbed } from "../embeds.js";
import { requireVoiceChannel } from "./helpers.js";

/**
 * 999 FM relay.
 *
 * Radio is a distinct playback source, not a queue item. Entering radio mode
 * **suspends** the queue rather than destroying it, and `radio stop` puts the
 * listener back exactly where they were.
 */
export default {
    name: "radio",
    aliases: ["fm", "999"],
    category: "Radio",
    description: "Relay the live 999 FM station into voice.",
    usage: "{prefix}radio [stop|status]",
    options: [
        {
            name: "action",
            description: "Leave empty to start, or use stop / status",
            type: "string",
            required: false,
            choices: ["stop", "status"],
        },
    ],
    guildOnly: true,
    notes:
        "Starting the station suspends your queue instead of clearing it; `radio stop` resumes it where it " +
        "stopped. The stream is live, so seek, loop, skip and queue edits are unavailable while it plays.",
    async execute(ctx) {
        const { players, radio, config } = ctx.deps;
        const action = (ctx.args[0] ?? "").toLowerCase();

        // `status` reports without joining anything.
        if (action === "status") {
            await ctx.defer();
            await radio.fetch();
            return ctx.reply(radio.buildEmbedPayload());
        }

        if (action === "stop") {
            const player = players.get(ctx.guildId);
            if (!player || player.destroyed || !player.radioMode) {
                throw new UserError("The station is not playing.");
            }
            const { resumed } = await player.stopRadio();
            radio.unsubscribe(ctx.guildId);
            radio.clearStatusMessage(ctx.guildId);

            return ctx.reply({
                embeds: [
                    successEmbed(
                        "Station stopped",
                        resumed
                            ? `Back to your queue — resuming **${resumed.song.title}**.`
                            : "Your queue was empty, so nothing resumed."
                    ),
                ],
            });
        }

        if (action) {
            throw new UserError(`Unknown option "${action}". Use \`${config.prefix}radio\`, \`radio stop\`, or \`radio status\`.`);
        }

        const channel = requireVoiceChannel(ctx);
        await ctx.defer();

        // Subscribing refreshes the station first, so the stream URL used is
        // current rather than whatever was cached minutes ago.
        await radio.subscribe(ctx.guildId);
        await players.ensure(ctx.guildId).startRadio({ channel, streamUrl: radio.streamUrl() });

        const message = await ctx.reply(radio.buildEmbedPayload());

        // Register this reply so a track change edits it in place instead of
        // posting a new embed every few minutes.
        radio.registerStatusMessage(ctx.guildId, (payload) => ctx.editReply(payload));
        return message;
    },
};
