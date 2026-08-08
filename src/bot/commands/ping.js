import { pingEmbed } from "../embeds.js";

export default {
    name: "ping",
    aliases: [],
    category: "Utility",
    description: "Gateway latency, archive health, and memory use.",
    usage: "{prefix}ping",
    options: [],
    guildOnly: false,
    async execute(ctx) {
        const { api, clock, startedAt, gatewayPing, memoryUsage } = ctx.deps;

        const started = clock.now();
        let archiveOk = false;
        try {
            const health = await api.health();
            archiveOk = health?.status === "ok";
        } catch {
            archiveOk = false;
        }
        const archiveMs = clock.now() - started;

        return ctx.reply({
            embeds: [
                pingEmbed({
                    gatewayMs: gatewayPing(),
                    archiveMs,
                    archiveOk,
                    rssMb: Math.round(memoryUsage().rss / 1024 / 1024),
                    uptimeMs: clock.now() - startedAt,
                }),
            ],
        });
    },
};
