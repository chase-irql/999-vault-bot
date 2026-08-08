import { UserError } from "../../core/errors.js";

/**
 * Shared guards for the playback commands.
 *
 * These deliberately return the opaque channel handle from the context rather
 * than anything from discord.js, so commands stay surface-agnostic and the audio
 * layer remains the only thing that knows what a voice channel is.
 */

/** The invoker's voice channel, or a UserError naming what to do about it. */
export function requireVoiceChannel(ctx) {
    const channel = ctx.getMemberVoiceChannel();
    if (!channel) {
        // Explicitly no join attempt: nothing to join to.
        throw new UserError("Join a voice channel first, then run that again.");
    }
    return channel;
}

/** The guild's existing player, or a UserError. Never creates one. */
export function requireActivePlayer(ctx) {
    const player = ctx.deps.players.get(ctx.guildId);
    if (!player || player.destroyed) {
        throw new UserError(`Nothing is playing. Start something with \`${ctx.deps.config.prefix}play\`.`);
    }
    return player;
}

/** Parses `mm:ss`, `h:mm:ss`, or a bare number of seconds. */
export function parseTimestamp(input) {
    const text = String(input ?? "").trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text);
    if (!/^\d{1,3}(:\d{1,2}){1,2}$/.test(text)) return null;

    const parts = text.split(":").map(Number);
    if (parts.slice(1).some((part) => part > 59)) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Positive integer argument, or a UserError naming the expected form. */
export function requirePosition(value, label, usage) {
    const number = Number(String(value ?? "").trim());
    if (!Number.isInteger(number) || number < 1) {
        throw new UserError(`${label} must be a whole number, 1 or greater — for example \`${usage}\`.`);
    }
    return number;
}
