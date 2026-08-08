import { statsEmbed } from "../embeds.js";

export default {
    name: "stats",
    aliases: [],
    category: "Utility",
    description: "Archive totals plus bot uptime, guilds, and active players.",
    usage: "{prefix}stats",
    guildOnly: false,
    async execute(ctx) {
        const { archive, clock, startedAt, guildCount, players } = ctx.deps;

        await ctx.defer();
        const stats = await archive.stats();

        return ctx.reply({
            embeds: [
                statsEmbed({
                    stats,
                    uptimeMs: clock.now() - startedAt,
                    guildCount: guildCount(),
                    activePlayers: players?.size ?? 0,
                    radioGuilds: players?.radioCount ?? 0,
                }),
            ],
        });
    },
};
