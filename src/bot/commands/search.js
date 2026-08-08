import { UserError } from "../../core/errors.js";
import { noResultsEmbed, searchEmbed } from "../embeds.js";

export default {
    name: "search",
    aliases: ["find"],
    category: "Archive",
    description: "Search the archive and list the top matches.",
    usage: "{prefix}search <query>",
    options: [{ name: "query", description: "Title, alternate title, or era", type: "string", required: true }],
    guildOnly: false,
    notes: "Each result shows the exact `play` invocation for it, so an ambiguous title can be pinned by id.",
    async execute(ctx) {
        const { archive, config } = ctx.deps;
        const query = ctx.rest.trim();
        if (!query) throw new UserError(`Give me something to search for — \`${config.prefix}search lucid dreams\`.`);

        await ctx.defer();
        const { results, totalCount } = await archive.search(query, { limit: 10 });

        if (results.length === 0) {
            const { totalSongs } = await archive.stats().catch(() => ({ totalSongs: null }));
            return ctx.reply({ embeds: [noResultsEmbed({ query, totalSongs, prefix: config.prefix })] });
        }

        return ctx.reply({
            embeds: [
                searchEmbed(
                    results.map((candidate) => candidate.song),
                    { query, prefix: config.prefix, totalCount }
                ),
            ],
        });
    },
};
