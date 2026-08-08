import { userMessageFor } from "../core/errors.js";
import { errorEmbed } from "./embeds.js";

/**
 * CommandContext — the boundary between commands and Discord.
 *
 * A command never sees a Message. It sees this object, so a test can build one
 * by hand and assert on what the command tried to send, with no gateway.
 *
 * The prefix surface is the only surface; see docs/decisions/0006-prefix-only.md
 * for why the slash surface was removed and what that trades away.
 *
 * @typedef {object} CommandContext
 * @property {"prefix"} source
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

/** Builds a context from a `messageCreate` event — the only surface. */
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
