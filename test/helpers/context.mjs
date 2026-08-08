/**
 * Test doubles for the command layer.
 *
 * Because commands only ever see a CommandContext, a fake one plus a mocked
 * ArchiveApi and a fake player is enough to exercise a command end to end with
 * no gateway, no voice connection, and no network.
 */

import { createRegistry } from "../../src/bot/commands/index.js";
import { loadConfig } from "../../src/config.js";

export function testConfig(overrides = {}) {
    return loadConfig({
        DISCORD_TOKEN: "test-token-value-not-a-real-token",
        DISCORD_CLIENT_ID: "1040000000000000000",
        ...overrides,
    });
}

export function fakeClock(start = 1_700_000_000_000) {
    let now = start;
    return {
        now: () => now,
        advance(ms) {
            now += ms;
            return now;
        },
        set(value) {
            now = value;
        },
    };
}

/** Records every reply instead of sending it. */
export function createContext({
    args = [],
    rest = args.join(" "),
    deps = {},
    guildId = "1040000000000000001",
    channelId = "1040000000000000002",
    userId = "1040000000000000003",
    voiceChannel = null,
    source = "prefix",
    commandName = "test",
} = {}) {
    const replies = [];
    const ctx = {
        source,
        commandName,
        guildId,
        channelId,
        userId,
        userTag: "tester#0001",
        memberVoiceChannelId: voiceChannel?.id ?? null,
        getMemberVoiceChannel: () => voiceChannel,
        args,
        rest,
        deferred: false,
        replies,
        async defer() {
            ctx.deferred = true;
        },
        async reply(payload) {
            replies.push(typeof payload === "string" ? { content: payload } : payload);
            return { id: `reply-${replies.length}` };
        },
        async editReply(payload) {
            replies.push(typeof payload === "string" ? { content: payload } : payload);
            return { id: `edit-${replies.length}` };
        },
        deps: {
            config: testConfig(),
            registry: createRegistry(),
            clock: fakeClock(),
            startedAt: 1_700_000_000_000,
            logger: silentLogger(),
            memoryUsage: () => ({ rss: 100 * 1024 * 1024 }),
            gatewayPing: () => 42,
            guildCount: () => 1,
            ...deps,
        },
    };
    return ctx;
}

export function silentLogger() {
    const noop = () => {};
    const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
    return logger;
}

/** Captures log records for assertions. */
export function recordingLogger() {
    const records = [];
    const push = (level) => (msg, fields) => records.push({ level, msg, fields });
    const logger = {
        records,
        debug: push("debug"),
        info: push("info"),
        warn: push("warn"),
        error: push("error"),
        child: () => logger,
    };
    return logger;
}

/** The single embed a command replied with, for assertions. */
export function lastEmbed(ctx) {
    const last = ctx.replies.at(-1);
    return last?.embeds?.[0] ?? null;
}

/** Every string rendered inside an embed — used to prove what a command did not print. */
export function embedText(embed) {
    if (!embed) return "";
    return [
        embed.title,
        embed.description,
        embed.author?.name,
        embed.footer?.text,
        ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
    ]
        .filter(Boolean)
        .join("\n");
}
