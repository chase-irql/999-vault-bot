import { ApplicationFlagsBitField, Client, Events, GatewayIntentBits } from "discord.js";
import { isUserFacing } from "../core/errors.js";
import { contextFromMessage, errorPayload } from "./context.js";
import { parseCommand } from "./router.js";

/**
 * discord.js wiring: intents, event routing, allowlist gating, lifecycle.
 * Commands are reached only through CommandContext, so this module is the single
 * place that knows the gateway exists.
 *
 * There is no slash surface — see docs/decisions/0006-prefix-only.md. That makes
 * Message Content load-bearing: without it there is no command surface at all,
 * which is why the login fallback below logs so loudly.
 *
 * Nothing here needs GuildMembers or GuildPresences — the two privileged intents
 * we do not request. `GuildVoiceStates` already carries the member voice state
 * the audio layer needs.
 */

const BASE_INTENTS = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
];

/** Thrown by the gateway when a privileged intent is requested but not granted. */
function isDisallowedIntents(error) {
    const text = `${error?.message ?? ""} ${error?.code ?? ""}`;
    return /disallowed intents/i.test(text);
}

export function createBotClient({ config, logger, deps }) {
    let client = null;
    let messageContentEnabled = false;
    let closing = false;

    const commands = deps.registry;

    function buildClient({ withMessageContent }) {
        const intents = withMessageContent
            ? [...BASE_INTENTS, GatewayIntentBits.MessageContent]
            : [...BASE_INTENTS];
        return new Client({ intents });
    }

    async function enforceAllowlist(guild, reason) {
        if (config.guildAllowlist.length === 0) return false;
        if (config.guildAllowlist.includes(guild.id)) return false;
        logger.warn("leaving guild not on allowlist", { guildId: guild.id, guildName: guild.name, reason });
        await guild.leave().catch((error) => logger.error("failed to leave guild", { guildId: guild.id, error }));
        return true;
    }

    /**
     * `GatewayMessageContent` is the verified flag; `Limited` is what an
     * unverified bot under 100 guilds gets. Either means messages carry content.
     */
    function checkMessageContentGrant() {
        const flags = client.application?.flags;
        if (!flags) return;
        const bits = new ApplicationFlagsBitField(flags);
        const granted =
            bits.has(ApplicationFlagsBitField.Flags.GatewayMessageContent) ||
            bits.has(ApplicationFlagsBitField.Flags.GatewayMessageContentLimited);
        if (!granted) {
            logger.warn(
                "Message Content intent is not granted, so NO commands will work — prefix is the only " +
                    "surface. Enable it at Developer Portal -> your application -> Bot -> Privileged " +
                    "Gateway Intents -> Message Content Intent, then restart."
            );
            messageContentEnabled = false;
        }
    }

    async function dispatch(ctx, command) {
        const log = logger.child({
            command: command.name,
            surface: ctx.source,
            guildId: ctx.guildId,
            userId: ctx.userId,
        });
        try {
            await command.execute(ctx);
        } catch (error) {
            if (isUserFacing(error)) {
                log.debug("command rejected input", { message: error.message });
            } else {
                log.error("command failed", { error });
            }
            await ctx.reply(errorPayload(error)).catch((replyError) => {
                log.error("failed to deliver error reply", { error: replyError });
            });
        }
    }

    /**
     * Channel gating. Empty allowlist means every channel, which is the default
     * and matches how Discord itself behaves.
     *
     * Note this is a convenience, not a security boundary: the real enforcement
     * is Discord's own channel permission overwrites, which stop the event
     * reaching the process at all. (Integrations -> Command Permissions does not
     * apply — it governs slash commands, and there are none.)
     */
    function channelAllowed(channelId) {
        if (config.channelAllowlist.length === 0) return true;
        return config.channelAllowlist.includes(channelId);
    }

    function onMessageCreate(message) {
        void (async () => {
            if (message.author.bot || !message.guild) return;
            // Silently ignored rather than refused: answering "wrong channel" in
            // the wrong channel is the noise the allowlist exists to prevent.
            if (!channelAllowed(message.channelId)) return;

            // A bare `1`-`5` may be answering an open disambiguation prompt.
            if (deps.pending?.handleMessage && (await deps.pending.handleMessage(message))) return;

            const parsed = parseCommand(message.content, config.prefix, { isBot: message.author.bot });
            if (!parsed) return;

            const command = commands.find(parsed.name);
            if (!command) return;
            if (command.guildOnly && !message.guildId) return;

            await dispatch(contextFromMessage({ message, command, parsed, deps }), command);
        })();
    }

    async function start() {
        // Requesting MessageContent when the portal toggle is off makes the
        // gateway refuse the connection outright, so the fallback has to happen
        // around login rather than after it.
        for (const withMessageContent of [true, false]) {
            client = buildClient({ withMessageContent });
            wire();
            try {
                await client.login(config.token);
                messageContentEnabled = withMessageContent;
                if (!withMessageContent) {
                    // Connected but inert: the prefix surface is the only one,
                    // so without this intent there are no commands at all.
                    logger.warn(
                        "Connected WITHOUT the Message Content intent, so no commands will work — " +
                            "prefix is the only surface. Enable it at Developer Portal -> Bot -> Privileged " +
                            "Gateway Intents -> Message Content Intent, then restart."
                    );
                }
                return client;
            } catch (error) {
                await client.destroy().catch(() => {});
                if (withMessageContent && isDisallowedIntents(error)) {
                    logger.warn("gateway rejected the Message Content intent; retrying without it");
                    continue;
                }
                throw error;
            }
        }
        return client;
    }

    function wire() {
        client.once(Events.ClientReady, (ready) => {
            void (async () => {
                logger.info("connected", {
                    user: ready.user.tag,
                    userId: ready.user.id,
                    guilds: ready.guilds.cache.size,
                    messageContentIntent: messageContentEnabled,
                });
                await ready.application.fetch().catch(() => {});
                if (messageContentEnabled) checkMessageContentGrant();
                for (const guild of ready.guilds.cache.values()) {
                    await enforceAllowlist(guild, "startup sweep");
                }
            })();
        });

        client.on(Events.GuildCreate, (guild) => {
            void (async () => {
                if (await enforceAllowlist(guild, "guildCreate")) return;
                logger.info("joined guild", { guildId: guild.id, guildName: guild.name });
            })();
        });

        client.on(Events.GuildDelete, (guild) => {
            deps.players?.destroy(guild.id, "guild removed");
            logger.info("left guild", { guildId: guild.id });
        });

        client.on(Events.VoiceStateUpdate, (oldState, newState) => {
            deps.voiceEvents?.onVoiceStateUpdate(oldState, newState);
        });

        client.on(Events.MessageCreate, onMessageCreate);

        client.on(Events.Error, (error) => logger.error("gateway error", { error }));
        client.on(Events.Warn, (message) => logger.warn("gateway warning", { message }));
        client.on(Events.ShardDisconnect, (event, id) =>
            logger.warn("shard disconnected", { shard: id, code: event?.code })
        );
        client.on(Events.ShardReconnecting, (id) => logger.info("shard reconnecting", { shard: id }));
    }

    async function destroy() {
        if (closing) return;
        closing = true;
        deps.players?.destroyAll("shutdown");
        deps.radio?.stop();
        // Drops every pending-disambiguation timer so nothing holds the loop open.
        deps.pending?.clear();
        await client?.destroy().catch(() => {});
    }

    return {
        start,
        destroy,
        get client() {
            return client;
        },
        get messageContentEnabled() {
            return messageContentEnabled;
        },
        gatewayPing: () => client?.ws?.ping ?? -1,
        guildCount: () => client?.guilds?.cache?.size ?? 0,
    };
}
