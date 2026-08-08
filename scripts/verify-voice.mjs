import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AudioPlayerStatus, VoiceConnectionStatus, entersState } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { ArchiveApi } from "../src/api/client.js";
import { createArchiveService } from "../src/api/resolve.js";
import { resolveFfmpegPath } from "../src/audio/ffmpeg.js";
import { createRadioStation, getPollerInstances } from "../src/audio/radio.js";
import { createPlayerRegistry } from "../src/audio/registry.js";
import { loadConfig } from "../src/config.js";
import { createLogger, registerSecret } from "../src/core/logger.js";

/**
 * Real gateway, real voice connection, real audio.
 *
 * This is the only check that can prove audio actually comes out, so it asserts
 * timing rather than merely "it did not throw":
 *
 *   - VoiceConnectionStatus.Ready within 10 s
 *   - AudioPlayerStatus.Playing within 4 s of resource creation
 *   - continuous Playing for 30 s with ZERO Buffering re-entries
 *   - playbackDuration advanced by >= 29,000 ms
 *   - clean stop() and destroy(), with active handles back to baseline
 *
 * Usage:
 *   npm run verify:voice                  queued track in TEST_GUILD_ID
 *   npm run verify:voice -- --radio       999 FM in TEST_GUILD_ID
 *   npm run verify:voice -- --guilds 2    isolation matrix across two guilds
 *
 * It is deliberately not run in CI: it needs a real token, a real guild and a
 * real voice channel, and its assertions are about audio timing on a live
 * connection, which a shared runner cannot measure meaningfully.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const RADIO_MODE = args.includes("--radio");
const GUILD_COUNT = Number(args[args.indexOf("--guilds") + 1]) || 1;
const TEST_QUERY = process.env.TEST_QUERY || "lucid dreams";

const PLAY_TIMEOUT_MS = 4_000;
const READY_TIMEOUT_MS = 10_000;
const OBSERVE_MS = 30_000;
const MIN_PLAYBACK_MS = 29_000;

const results = [];
let failures = 0;

function check(name, passed, detail = "") {
    results.push({ name, passed, detail: String(detail) });
    process.stdout.write(`  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
    if (!passed) failures += 1;
    return passed;
}

function fatal(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

const config = (() => {
    try {
        return loadConfig(process.env);
    } catch (error) {
        return fatal(error.message);
    }
})();

registerSecret(config.token);
const logger = createLogger({ level: config.logLevel === "debug" ? "debug" : "warn", name: "verify-voice" });

const guildIds = [config.test.guildId, config.test.guildId2].filter(Boolean).slice(0, GUILD_COUNT);
const channelIds = [config.test.voiceChannelId, config.test.voiceChannelId2].filter(Boolean).slice(0, GUILD_COUNT);

if (guildIds.length < GUILD_COUNT || channelIds.length < GUILD_COUNT) {
    fatal(
        `This test needs ${GUILD_COUNT} guild/channel pair(s). Set TEST_GUILD_ID and TEST_VOICE_CHANNEL_ID` +
            (GUILD_COUNT > 1 ? ", plus TEST_GUILD_ID_2 and TEST_VOICE_CHANNEL_ID_2" : "") +
            " in .env."
    );
}

const ffmpeg = (() => {
    try {
        return resolveFfmpegPath(config);
    } catch (error) {
        return fatal(error.message);
    }
})();

const api = new ArchiveApi({ baseUrl: config.apiBaseUrl, timeoutMs: config.apiTimeoutMs, retries: config.apiRetries });
const archive = createArchiveService({ api, config });
const radio = createRadioStation({ api, config, logger });
const players = createPlayerRegistry({ config, logger, ffmpegPath: ffmpeg.path });

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

/** Instruments a player's transitions so the assertions have something to read. */
function instrument(player) {
    const audioPlayer = player.internals.player;
    const timeline = { buffering: 0, playingAt: 0, transitions: [] };

    audioPlayer.on("stateChange", (oldState, newState) => {
        timeline.transitions.push({ at: Date.now(), from: oldState.status, to: newState.status });
        if (newState.status === AudioPlayerStatus.Playing && !timeline.playingAt) timeline.playingAt = Date.now();
        // Only re-entry counts: the first Buffering is how playback starts.
        if (newState.status === AudioPlayerStatus.Buffering && timeline.playingAt) timeline.buffering += 1;
    });
    return timeline;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runGuild(index) {
    const guildId = guildIds[index];
    const channelId = channelIds[index];
    const label = `guild ${index + 1}`;

    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isVoiceBased()) fatal(`${channelId} is not a voice channel.`);

    const player = players.ensure(guildId);
    const timeline = instrument(player);
    const startedAt = Date.now();

    if (RADIO_MODE) {
        await radio.subscribe(guildId);
        await player.startRadio({ channel, streamUrl: radio.streamUrl() });
    } else {
        const outcome = await archive.resolve(TEST_QUERY);
        if (outcome.kind !== "one") fatal(`"${TEST_QUERY}" did not resolve to a single track (${outcome.kind}).`);
        await player.enqueue(outcome.song, { requesterId: client.user.id, channel });
        check(`${label}: resolved a track`, true, outcome.song.title);
    }

    const connection = player.internals.connection;
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
        check(`${label}: connection Ready within 10s`, true, `${Date.now() - startedAt} ms`);
    } catch {
        check(`${label}: connection Ready within 10s`, false, "timed out");
        return { label, guildId, timeline };
    }

    const resourceAt = Date.now();
    try {
        await entersState(player.internals.player, AudioPlayerStatus.Playing, PLAY_TIMEOUT_MS);
        check(`${label}: Playing within 4s of resource creation`, true, `${Date.now() - resourceAt} ms`);
    } catch {
        check(`${label}: Playing within 4s of resource creation`, false, "timed out");
    }

    return { label, guildId, timeline, player, startedAt };
}

async function observe(sessions) {
    process.stdout.write(`\nobserving for ${OBSERVE_MS / 1000}s…\n`);
    const before = sessions.map((session) => session.player?.internals.source?.resource?.playbackDuration ?? 0);
    await sleep(OBSERVE_MS);

    sessions.forEach((session, index) => {
        const { label, timeline, player } = session;
        if (!player) return;

        const advanced = (player.internals.source?.resource?.playbackDuration ?? 0) - before[index];
        check(`${label}: playbackDuration advanced >= 29,000 ms`, advanced >= MIN_PLAYBACK_MS, `${advanced} ms`);
        check(`${label}: zero Buffering re-entries over 30s`, timeline.buffering === 0, `${timeline.buffering} re-entries`);
        check(`${label}: still Playing at the end`, player.snapshot().status === "playing", player.snapshot().status);
    });
}

/** The isolation assertions the brief requires across two real guilds. */
async function isolationMatrix(sessions) {
    if (sessions.length < 2) return;
    process.stdout.write("\nisolation matrix\n");

    const [a, b] = sessions;
    const beforeB = b.player.snapshot();

    await a.player.skip().catch(() => {});
    a.player.setVolume(25);
    try {
        a.player.setLoop("queue");
    } catch {
        // Not applicable in radio mode.
    }

    const afterB = b.player.snapshot();
    check("guild A skip/volume/loop did not change guild B's volume", afterB.volume === beforeB.volume);
    check("guild A skip/volume/loop did not change guild B's loop", afterB.loop === beforeB.loop);
    check(
        "guild A skip/volume/loop did not change guild B's queue",
        JSON.stringify(afterB.queue.map((entry) => entry.song?.id)) ===
            JSON.stringify(beforeB.queue.map((entry) => entry.song?.id))
    );
    check("exactly one /radio/live/ poller exists in the process", getPollerInstances() <= 1, String(getPollerInstances()));

    players.destroy(a.guildId, "matrix");
    check("destroying guild A left guild B playing", b.player.destroyed === false);
    check("destroying guild A removed only its registry entry", players.has(a.guildId) === false && players.has(b.guildId));

    // Shared cache must not bleed between guilds.
    const first = await archive.search("lucid dreams", { limit: 5 });
    const second = await archive.search("robbery", { limit: 5 });
    const firstIds = new Set(first.results.map((entry) => entry.song.id));
    check(
        "the shared archive cache serves both guilds without cross-guild bleed",
        second.results.every((entry) => !firstIds.has(entry.song.id))
    );
}

async function main() {
    const handleBaseline = process._getActiveHandles().length;

    await client.login(config.token);
    await entersState(client, Events.ClientReady, 20_000).catch(() => {});
    if (!client.isReady()) await new Promise((resolve) => client.once(Events.ClientReady, resolve));
    process.stdout.write(`logged in as ${client.user.tag}\n\n`);

    const sessions = [];
    for (let index = 0; index < GUILD_COUNT; index += 1) sessions.push(await runGuild(index));

    await observe(sessions);
    await isolationMatrix(sessions);

    process.stdout.write("\nteardown\n");
    players.destroyAll("smoke test complete");
    radio.stop();
    await client.destroy();
    await sleep(1_000);

    const handlesAfter = process._getActiveHandles().length;
    check(
        "active handles returned to baseline after teardown",
        handlesAfter <= handleBaseline + 1,
        `${handleBaseline} -> ${handlesAfter}`
    );

    const report = {
        startedAt: new Date().toISOString(),
        mode: RADIO_MODE ? "radio" : "queue",
        guilds: GUILD_COUNT,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        ffmpeg: { path: ffmpeg.path, source: ffmpeg.source },
        query: RADIO_MODE ? null : TEST_QUERY,
        checks: results,
        passed: failures === 0,
        failures,
    };

    const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
    const name =
        GUILD_COUNT > 1
            ? `multi-guild-${stamp}.json`
            : `voice-smoke${RADIO_MODE ? "-radio" : ""}-${stamp}.json`;
    await mkdir(path.join(root, "evidence"), { recursive: true });
    await writeFile(path.join(root, "evidence", name), `${JSON.stringify(report, null, 2)}\n`);

    process.stdout.write(`\nreport written to evidence/${name}\n`);
    process.stdout.write(failures === 0 ? "verify:voice PASSED\n" : `verify:voice FAILED (${failures})\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
    process.stderr.write(`verify:voice crashed: ${error?.message}\n`);
    players.destroyAll("crash");
    radio.stop();
    await client.destroy().catch(() => {});
    process.exit(1);
});
