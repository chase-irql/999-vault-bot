import { UserError } from "../../core/errors.js";
import { disambiguationEmbed, noResultsEmbed, queuedEmbed } from "../embeds.js";
import { DEFAULT_TIMEOUT_MS } from "../pending.js";
import { requireVoiceChannel } from "./helpers.js";

/**
 * The primary command. Free-form text in, the right track playing out — or an
 * honest question when the archive genuinely holds several candidates.
 */
async function play(ctx, { next }) {
    const { archive, players, pending, config } = ctx.deps;
    const query = ctx.rest.trim();
    if (!query) {
        throw new UserError(`What should I play? Try \`${config.prefix}play lucid dreams\`.`);
    }

    // Checked before anything else so a user not in voice never triggers an
    // archive request or a join attempt.
    const channel = requireVoiceChannel(ctx);

    await ctx.defer();
    const outcome = await archive.resolve(query);

    if (outcome.kind === "none") {
        return ctx.reply({
            embeds: [noResultsEmbed({ query, totalSongs: outcome.totalSongs, prefix: config.prefix })],
        });
    }

    const start = async (song) => {
        const result = await players.ensure(ctx.guildId).enqueue(song, {
            requesterId: ctx.userId,
            channel,
            next,
        });
        return ctx.editReply({
            embeds: [queuedEmbed({ song, position: result.position, requesterId: `<@${ctx.userId}>` })],
        });
    };

    if (outcome.kind === "one") {
        return start(outcome.song);
    }

    // Ambiguous: ask, and accept either a bare number from this user in this
    // channel or an explicit `play <id>`.
    const candidates = outcome.candidates.map((candidate) => candidate.song);
    pending.open({
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        candidates,
        onChoose: (song) => start(song),
    });

    return ctx.reply({
        embeds: [
            disambiguationEmbed(candidates, {
                query,
                prefix: config.prefix,
                timeoutSeconds: Math.round(DEFAULT_TIMEOUT_MS / 1000),
            }),
        ],
    });
}

export default {
    name: "play",
    aliases: ["p"],
    category: "Playback",
    description: "Resolve a track, join your voice channel, and play or queue it.",
    usage: "{prefix}play <query|id>",
    options: [{ name: "query", description: "Title, alternate title, song id, or archive path", type: "string", required: true }],
    guildOnly: true,
    notes:
        "When several archive entries match, you get a numbered list — reply with a number within 60 seconds, " +
        "or run `play <id>` with the id shown.",
    execute: (ctx) => play(ctx, { next: false }),
};

export const playNext = {
    name: "playnext",
    aliases: ["pn"],
    category: "Playback",
    description: "Same as play, but jumps the queue to position 1.",
    usage: "{prefix}playnext <query|id>",
    options: [{ name: "query", description: "Title, alternate title, song id, or archive path", type: "string", required: true }],
    guildOnly: true,
    execute: (ctx) => play(ctx, { next: true }),
};
