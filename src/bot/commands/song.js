import { UserError } from "../../core/errors.js";
import { disambiguationEmbed, noResultsEmbed, songEmbed } from "../embeds.js";

export default {
    name: "song",
    aliases: ["info"],
    category: "Archive",
    description: "Archive metadata for one track, with no playback.",
    usage: "{prefix}song <query>",
    guildOnly: false,
    // Stated in help so the omission reads as a decision rather than a gap.
    notes: "Metadata only. This bot never posts lyrics.",
    async execute(ctx) {
        const { archive, config } = ctx.deps;
        const query = ctx.rest.trim();
        if (!query) throw new UserError(`Which track? Try \`${config.prefix}song lucid dreams\`.`);

        await ctx.defer();
        const outcome = await archive.resolve(query);

        if (outcome.kind === "none") {
            return ctx.reply({
                embeds: [
                    noResultsEmbed({ query, totalSongs: outcome.totalSongs, prefix: config.prefix }),
                ],
            });
        }

        if (outcome.kind === "many") {
            // No pending prompt here: `song` has no side effect worth waiting for,
            // so it lists the options and lets the user pick by id.
            return ctx.reply({
                embeds: [
                    disambiguationEmbed(
                        outcome.candidates.map((candidate) => candidate.song),
                        { query, prefix: config.prefix, timeoutSeconds: 0 }
                    ),
                ],
            });
        }

        return ctx.reply({ embeds: [songEmbed(outcome.song)] });
    },
};
