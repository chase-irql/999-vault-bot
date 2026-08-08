import { userMessageFor } from "../core/errors.js";
import { errorEmbed } from "./embeds.js";

/**
 * CommandContext — the boundary that lets one command implementation serve both
 * the prefix surface and the slash surface.
 *
 * A command never sees a Message or an Interaction. It sees this object, whose
 * shape is identical whichever surface produced it, so a test can build one by
 * hand and assert on what the command tried to send.
 *
 * @typedef {object} CommandContext
 * @property {"prefix"|"slash"} source
 * @property {string} guildId
 * @property {string} channelId
 * @property {string} userId
 * @property {string|null} memberVoiceChannelId
 * @property {() => unknown|null} getMemberVoiceChannel opaque channel handle for the audio layer
 * @property {string[]} args
 * @property {string} rest
 * @property {(payload: object) => Promise<unknown>} reply
 * @property {(payload: object) => Promise<unknown>} editReply
 * @property {() => Promise<void>} defer
 * @property {object} deps injected services
 */

function payloadOf(input) {
    if (typeof input === "string") return { content: input };
    return input;
}

/** Turns any error into a single-embed reply. Never leaks a stack or a URL. */
export function errorPayload(error) {
    return {
        embeds: [errorEmbed(error?.title ?? "That did not work", userMessageFor(error))],
    };
}

/**
 * Slash options are declared per-command in a discord.js-free spec. Reading them
 * back in declaration order and re-joining them reproduces exactly the `rest`
 * string a prefix invocation would have produced, so downstream parsing is
 * shared rather than duplicated per surface.
 */
export function restFromOptions(interaction, options) {
    const parts = [];
    for (const option of options) {
        const value = interaction.options.get(option.name)?.value;
        if (value === undefined || value === null || value === "") continue;
        parts.push(String(value));
    }
    return parts.join(" ").trim();
}

export function tokenizeRest(rest, tokenize) {
    return rest ? tokenize(rest) : [];
}

/** Builds a context from a `messageCreate` event. */
export function contextFromMessage({ message, command, parsed, deps }) {
    let replied = null;
    return {
        source: "prefix",
        commandName: command.name,
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        memberVoiceChannelId: message.member?.voice?.channelId ?? null,
        getMemberVoiceChannel: () => message.member?.voice?.channel ?? null,
        args: parsed.args,
        rest: parsed.rest,
        deferred: false,
        async defer() {
            // Prefix messages have no defer; typing is the closest honest signal.
            await message.channel.sendTyping().catch(() => {});
        },
        async reply(payload) {
            replied = await message.reply({ ...payloadOf(payload), allowedMentions: { repliedUser: false } });
            return replied;
        },
        async editReply(payload) {
            if (!replied) return this.reply(payload);
            return replied.edit(payloadOf(payload));
        },
        deps,
    };
}

/** Builds a context from a `ChatInputCommandInteraction`. */
export function contextFromInteraction({ interaction, command, args, rest, deps }) {
    return {
        source: "slash",
        commandName: command.name,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        memberVoiceChannelId: interaction.member?.voice?.channelId ?? null,
        getMemberVoiceChannel: () => interaction.member?.voice?.channel ?? null,
        args,
        rest,
        get deferred() {
            return interaction.deferred;
        },
        async defer() {
            if (!interaction.deferred && !interaction.replied) await interaction.deferReply();
        },
        async reply(payload) {
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(payloadOf(payload));
            }
            return interaction.reply(payloadOf(payload));
        },
        async editReply(payload) {
            if (!interaction.deferred && !interaction.replied) return this.reply(payload);
            return interaction.editReply(payloadOf(payload));
        },
        deps,
    };
}
