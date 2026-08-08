import { UserError } from "../../core/errors.js";
import { formatDuration, infoEmbed, nowPlayingEmbed, queueEmbed, successEmbed } from "../embeds.js";
import { parseTimestamp, requireActivePlayer, requirePosition, requireVoiceChannel } from "./helpers.js";

/**
 * The playback control surface. Each export is a registry entry; they live in
 * one file because each is a handful of lines over the same `GuildPlayer`
 * methods, and fifteen near-identical files would hide that symmetry rather
 * than reveal it.
 *
 * Every one of these follows the same shape: guard, call one intent method on
 * the player, render the returned state. None of them mutates a queue, touches a
 * VoiceConnection, or builds an AudioResource.
 */

const QUEUE_PAGE_SIZE = 10;

export const pause = {
    name: "pause",
    aliases: [],
    category: "Playback",
    description: "Pause playback.",
    usage: "{prefix}pause",
    options: [],
    guildOnly: true,
    async execute(ctx) {
        const result = requireActivePlayer(ctx).pause();
        // Idempotent: pausing a paused player is a statement of fact, not an error.
        return ctx.reply({
            embeds: [
                result.changed
                    ? successEmbed("Paused", "Resume with `resume`.")
                    : infoEmbed("Already paused", "Resume with `resume`."),
            ],
        });
    },
};

export const resume = {
    name: "resume",
    aliases: ["unpause"],
    category: "Playback",
    description: "Resume playback.",
    usage: "{prefix}resume",
    options: [],
    guildOnly: true,
    async execute(ctx) {
        const result = requireActivePlayer(ctx).resume();
        return ctx.reply({
            embeds: [
                result.changed
                    ? successEmbed("Resumed", "Playing again.")
                    : infoEmbed("Already playing", "Nothing was paused."),
            ],
        });
    },
};

export const skip = {
    name: "skip",
    aliases: ["s", "next"],
    category: "Playback",
    description: "Skip to the next queued track.",
    usage: "{prefix}skip",
    options: [],
    guildOnly: true,
    notes: "A `track` loop is cleared for this advance only, so skip does not replay the same song.",
    async execute(ctx) {
        const { skipped, next } = await requireActivePlayer(ctx).skip();
        return ctx.reply({
            embeds: [
                successEmbed(
                    `Skipped ${skipped.song.title}`,
                    next ? `Now playing **${next.song.title}**.` : "The queue is empty."
                ),
            ],
        });
    },
};

export const stop = {
    name: "stop",
    aliases: [],
    category: "Playback",
    description: "Clear the queue, stop, and leave the channel.",
    usage: "{prefix}stop",
    options: [],
    guildOnly: true,
    async execute(ctx) {
        const player = ctx.deps.players.get(ctx.guildId);
        if (!player || player.destroyed) {
            return ctx.reply({ embeds: [infoEmbed("Not playing", "There was nothing to stop.")] });
        }
        await player.stop();
        return ctx.reply({ embeds: [successEmbed("Stopped", "Queue cleared and left the channel.")] });
    },
};

export const nowplaying = {
    name: "nowplaying",
    aliases: ["np"],
    category: "Playback",
    description: "Show the current track with a live progress bar.",
    usage: "{prefix}nowplaying",
    options: [],
    guildOnly: true,
    async execute(ctx) {
        const player = requireActivePlayer(ctx);
        const state = player.snapshot();

        if (state.radioMode) {
            const { radio } = ctx.deps;
            return ctx.reply({ embeds: [radio.buildEmbed()] });
        }
        if (!state.current) {
            throw new UserError("Nothing is playing.");
        }

        return ctx.reply({
            embeds: [
                nowPlayingEmbed({
                    song: state.current.song,
                    elapsedSeconds: state.elapsedSeconds,
                    requesterId: state.current.requesterId,
                    paused: state.status === "paused",
                    loopMode: state.loop,
                    volume: state.volume,
                    queueLength: state.queueLength,
                }),
            ],
        });
    },
};

export const queueCommand = {
    name: "queue",
    aliases: ["q"],
    category: "Playback",
    description: "Show the queue, ten per page.",
    usage: "{prefix}queue [page]",
    options: [{ name: "page", description: "Page number", type: "integer", required: false, min: 1 }],
    guildOnly: true,
    async execute(ctx) {
        const player = requireActivePlayer(ctx);
        if (player.radioMode) {
            throw new UserError(
                "999 FM is playing, so the queue is suspended. `radio stop` restores it where you left it."
            );
        }

        const requested = ctx.args[0] ? requirePosition(ctx.args[0], "Page", `${ctx.deps.config.prefix}queue 2`) : 1;
        const view = player.queuePage(requested, QUEUE_PAGE_SIZE);

        return ctx.reply({
            embeds: [
                queueEmbed({
                    current: view.snapshot.current,
                    items: view.items,
                    page: view.page,
                    pageCount: view.pageCount,
                    pageSize: view.pageSize,
                    totalDurationSeconds: view.snapshot.totalDurationSeconds,
                    elapsedSeconds: view.snapshot.elapsedSeconds,
                }),
            ],
        });
    },
};

export const remove = {
    name: "remove",
    aliases: ["rm"],
    category: "Playback",
    description: "Remove one track from the queue by position.",
    usage: "{prefix}remove <position>",
    options: [{ name: "position", description: "Queue position", type: "integer", required: true, min: 1 }],
    guildOnly: true,
    async execute(ctx) {
        const position = requirePosition(ctx.args[0], "Position", `${ctx.deps.config.prefix}remove 3`);
        const { removed } = requireActivePlayer(ctx).removeAt(position);
        return ctx.reply({
            embeds: [successEmbed("Removed", `**${removed.song.title}** is no longer queued.`)],
        });
    },
};

export const move = {
    name: "move",
    aliases: ["mv"],
    category: "Playback",
    description: "Move a queued track to another position.",
    usage: "{prefix}move <from> <to>",
    options: [
        { name: "from", description: "Current position", type: "integer", required: true, min: 1 },
        { name: "to", description: "New position", type: "integer", required: true, min: 1 },
    ],
    guildOnly: true,
    async execute(ctx) {
        const usage = `${ctx.deps.config.prefix}move 3 1`;
        const from = requirePosition(ctx.args[0], "The position to move from", usage);
        const to = requirePosition(ctx.args[1], "The position to move to", usage);
        const { moved } = requireActivePlayer(ctx).moveItem(from, to);
        return ctx.reply({
            embeds: [successEmbed("Moved", `**${moved.song.title}** is now at position ${to}.`)],
        });
    },
};

export const clear = {
    name: "clear",
    aliases: [],
    category: "Playback",
    description: "Empty the queue but keep the current track playing.",
    usage: "{prefix}clear",
    options: [],
    guildOnly: true,
    async execute(ctx) {
        const { removed } = requireActivePlayer(ctx).clearQueue();
        return ctx.reply({
            embeds: [
                successEmbed(
                    "Queue cleared",
                    removed === 0
                        ? "The queue was already empty."
                        : `Removed ${removed} track${removed === 1 ? "" : "s"}. The current track keeps playing.`
                ),
            ],
        });
    },
};

export const shuffle = {
    name: "shuffle",
    aliases: [],
    category: "Playback",
    description: "Shuffle the queued tracks.",
    usage: "{prefix}shuffle",
    options: [],
    guildOnly: true,
    async execute(ctx) {
        const state = requireActivePlayer(ctx).shuffleQueue();
        return ctx.reply({
            embeds: [successEmbed("Shuffled", `${state.queueLength} queued tracks reordered.`)],
        });
    },
};

export const loop = {
    name: "loop",
    aliases: ["repeat"],
    category: "Playback",
    description: "Set or cycle the loop mode.",
    usage: "{prefix}loop [off|track|queue]",
    options: [
        {
            name: "mode",
            description: "Loop mode",
            type: "string",
            required: false,
            choices: ["off", "track", "queue"],
        },
    ],
    guildOnly: true,
    async execute(ctx) {
        const player = requireActivePlayer(ctx);
        const requested = ctx.args[0]?.toLowerCase();
        const mode = requested ? player.setLoop(requested) : player.cycleLoop();

        const explanation = {
            off: "Tracks play once and the queue empties.",
            track: "The current track repeats. `skip` still moves on.",
            queue: "Finished tracks go back to the end of the queue.",
        }[mode];

        return ctx.reply({ embeds: [successEmbed(`Loop: ${mode}`, explanation)] });
    },
};

export const seek = {
    name: "seek",
    aliases: [],
    category: "Playback",
    description: "Jump to a position in the current track.",
    usage: "{prefix}seek <mm:ss|seconds>",
    options: [{ name: "position", description: "mm:ss, h:mm:ss, or seconds", type: "string", required: true }],
    guildOnly: true,
    notes: "Not available in radio mode — a live stream has no position to seek to.",
    async execute(ctx) {
        const seconds = parseTimestamp(ctx.rest);
        if (seconds === null) {
            throw new UserError(`Give a position like \`${ctx.deps.config.prefix}seek 1:30\` or \`90\`.`);
        }
        const state = await requireActivePlayer(ctx).seek(seconds);
        return ctx.reply({
            embeds: [
                successEmbed(
                    `Seeked to ${formatDuration(seconds)}`,
                    state.current ? `In **${state.current.song.title}**.` : ""
                ),
            ],
        });
    },
};

export const volume = {
    name: "volume",
    aliases: ["vol"],
    category: "Playback",
    description: "Set or report playback volume, 0 to 200.",
    usage: "{prefix}volume [0-200]",
    options: [{ name: "level", description: "Volume percentage", type: "integer", required: false, min: 0, max: 200 }],
    guildOnly: true,
    async execute(ctx) {
        const player = requireActivePlayer(ctx);
        if (!ctx.args[0]) {
            return ctx.reply({ embeds: [infoEmbed(`Volume: ${player.getVolume()}%`, "Set it with `volume 80`.")] });
        }

        const requested = Number(ctx.args[0]);
        if (!Number.isFinite(requested) || requested < 0 || requested > 200) {
            throw new UserError("Volume must be a number between 0 and 200.");
        }
        return ctx.reply({ embeds: [successEmbed(`Volume: ${player.setVolume(requested)}%`, "")] });
    },
};

export const join = {
    name: "join",
    aliases: [],
    category: "Playback",
    description: "Join your voice channel without playing anything.",
    usage: "{prefix}join",
    options: [],
    guildOnly: true,
    async execute(ctx) {
        const channel = requireVoiceChannel(ctx);
        await ctx.deps.players.ensure(ctx.guildId).join(channel);
        return ctx.reply({ embeds: [successEmbed("Joined", `Connected to **${channel.name}**.`)] });
    },
};

export const leave = {
    name: "leave",
    aliases: ["disconnect", "dc"],
    category: "Playback",
    description: "Leave the voice channel and clear the queue.",
    usage: "{prefix}leave",
    options: [],
    guildOnly: true,
    async execute(ctx) {
        const left = ctx.deps.players.destroy(ctx.guildId, "leave command");
        return ctx.reply({
            embeds: [
                left
                    ? successEmbed("Left", "Disconnected and cleared the queue.")
                    : infoEmbed("Not connected", "I was not in a voice channel."),
            ],
        });
    },
};
