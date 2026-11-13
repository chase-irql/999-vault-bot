import process from "node:process";
import { ArchiveApi } from "./api/client.js";
import { createArchiveService } from "./api/resolve.js";
import { createBotClient } from "./bot/client.js";
import { createRegistry } from "./bot/commands/index.js";
import { createPendingResolutions } from "./bot/pending.js";
import { loadConfig, secretsOf } from "./config.js";
import { resolveFfmpegPath, ffmpegVersion } from "./audio/ffmpeg.js";
import { createRadioStation } from "./audio/radio.js";
import { createPlayerRegistry } from "./audio/registry.js";
import { createVoiceEvents } from "./audio/voice-events.js";
import { createYouTube } from "./audio/youtube.js";
import { AppError } from "./core/errors.js";
import { createLogger, registerSecret } from "./core/logger.js";

/**
 * Composition root: config -> logger -> api -> registry -> client -> login.
 *
 * This is the only module that reads process.env, touches process signals, or
 * decides what gets wired to what. Everything below it receives its
 * dependencies as arguments, which is what makes the rest testable offline.
 */

const SHUTDOWN_DEADLINE_MS = 5_000;

function fail(message) {
    // Config failures happen before the logger exists, so this one line is the
    // whole error report. Deliberately not JSON — a human is reading it.
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

async function main() {
    let config;
    try {
        config = loadConfig(process.env);
    } catch (error) {
        return fail(error instanceof AppError ? error.message : `Configuration failed: ${error.message}`);
    }

    for (const secret of secretsOf(config)) registerSecret(secret);
    const logger = createLogger({ level: config.logLevel, name: "999-vault-bot" });

    let ffmpeg;
    try {
        ffmpeg = resolveFfmpegPath(config);
    } catch (error) {
        return fail(error.message);
    }

    const api = new ArchiveApi({
        baseUrl: config.apiBaseUrl,
        timeoutMs: config.apiTimeoutMs,
        retries: config.apiRetries,
        logger: logger.child({ module: "api" }),
    });

    const startedAt = Date.now();
    const clock = { now: () => Date.now() };
    const registry = createRegistry();

    // One archive service for the whole process: one cache, one rate gate. Guilds
    // share it read-only, keyed by query, so no guild can observe another's work.
    const archive = createArchiveService({
        api,
        config,
        clock,
        logger: logger.child({ module: "archive" }),
    });
    const youtube = createYouTube({
        ytDlpPath: config.ytDlpPath,
        nodePath: process.execPath,
        logger: logger.child({ module: "youtube" }),
    });

    // One player per guild, one registry for the process. The registry is the
    // only thing that may construct or destroy a player.
    const players = createPlayerRegistry({
        config,
        logger,
        ffmpegPath: ffmpeg.path,
        youtube,
        clock,
    });

    // One station poller for the whole process, regardless of how many guilds
    // are listening.
    const radio = createRadioStation({ api, config, logger, clock });

    const pending = createPendingResolutions({ logger });

    const voiceEvents = createVoiceEvents({
        players,
        logger,
        clientUserId: () => bot.client?.user?.id ?? "",
    });

    const deps = {
        config,
        logger,
        api,
        archive,
        youtube,
        registry,
        players,
        radio,
        pending,
        voiceEvents,
        clock,
        startedAt,
        ffmpeg,
        memoryUsage: () => process.memoryUsage(),
        gatewayPing: () => bot.gatewayPing(),
        guildCount: () => bot.guildCount(),
    };

    const bot = createBotClient({ config, logger, deps });

    logger.info("starting", {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        prefix: config.prefix,
        apiBaseUrl: config.apiBaseUrl,
        allowlist: config.guildAllowlist.length ? config.guildAllowlist : "disabled",
        ffmpegPath: ffmpeg.path,
        ffmpegSource: ffmpeg.source,
        ffmpegVersion: await ffmpegVersion(ffmpeg.path),
    });

    let shuttingDown = false;
    const shutdown = async (signal, code = 0) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info("shutting down", { signal });
        // Hard deadline: a wedged voice connection must not hold the process open.
        const deadline = setTimeout(() => {
            logger.warn("shutdown deadline exceeded, exiting anyway");
            process.exit(code);
        }, SHUTDOWN_DEADLINE_MS);
        deadline.unref();
        try {
            await bot.destroy();
        } catch (error) {
            logger.error("shutdown error", { error });
        }
        clearTimeout(deadline);
        logger.info("stopped");
        process.exit(code);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    // A rejection must be loud but must not take the process down: dropping every
    // guild's audio because one archive promise lost its handler is worse than
    // the bug it reports.
    process.on("unhandledRejection", (reason) => {
        logger.error("unhandled rejection", { error: reason instanceof Error ? reason : String(reason) });
    });
    process.on("uncaughtException", (error) => {
        logger.error("uncaught exception", { error });
        void shutdown("uncaughtException", 1);
    });

    try {
        await bot.start();
    } catch (error) {
        logger.error("login failed", { error });
        return fail("Could not log in to Discord. Check DISCORD_TOKEN and the bot's intents.");
    }
}

await main();
