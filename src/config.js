import { ConfigError } from "./core/errors.js";

/**
 * Environment parsing and validation. Pure with respect to its `env` argument so
 * tests can drive it without touching process.env.
 *
 * Every failure is a ConfigError with a single readable sentence. The process
 * exits non-zero on the first one rather than starting half-configured.
 */

const DEFAULTS = Object.freeze({
    COMMAND_PREFIX: "jw!",
    API_BASE_URL: "https://juicewrldapi.com/juicewrld",
    LOG_LEVEL: "info",
    IDLE_DISCONNECT_MS: 300_000,
    API_TIMEOUT_MS: 30_000,
    API_RETRIES: 4,
    DEFAULT_VOLUME: 100,
    RADIO_POLL_MS: 15_000,
});

const LOG_LEVELS = new Set(["debug", "info", "warn", "error", "silent"]);

/** Discord snowflakes are 17-20 digit decimal integers. */
const SNOWFLAKE = /^\d{17,20}$/;

function requiredString(env, key) {
    const value = (env[key] ?? "").trim();
    if (!value) throw new ConfigError(`${key} is required. Copy .env.example to .env and set it.`);
    return value;
}

function optionalString(env, key, fallback = "") {
    const value = (env[key] ?? "").trim();
    return value || fallback;
}

function integer(env, key, fallback, { min, max }) {
    const raw = (env[key] ?? "").trim();
    if (!raw) return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${key} must be a whole number, got "${raw}".`);
    const value = Number(raw);
    if (value < min || value > max) {
        throw new ConfigError(`${key} must be between ${min} and ${max}, got ${value}.`);
    }
    return value;
}

function snowflake(env, key, { required = false } = {}) {
    const value = optionalString(env, key);
    if (!value) {
        if (required) throw new ConfigError(`${key} is required. Copy .env.example to .env and set it.`);
        return "";
    }
    if (!SNOWFLAKE.test(value)) {
        throw new ConfigError(`${key} must be a Discord ID (17-20 digits), got "${value}".`);
    }
    return value;
}

function snowflakeList(env, key, label = "ID") {
    const raw = optionalString(env, key);
    if (!raw) return Object.freeze([]);
    const ids = raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    for (const id of ids) {
        if (!SNOWFLAKE.test(id)) {
            throw new ConfigError(`${key} entry "${id}" is not a Discord ${label} (17-20 digits).`);
        }
    }
    return Object.freeze([...new Set(ids)]);
}

function httpsUrl(env, key, fallback) {
    const raw = optionalString(env, key, fallback);
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new ConfigError(`${key} must be an absolute URL, got "${raw}".`);
    }
    if (url.protocol !== "https:") {
        throw new ConfigError(`${key} must use https, got "${url.protocol}//".`);
    }
    return url.toString().replace(/\/$/, "");
}

/**
 * Discord truncates nothing for us: a prefix with whitespace or one long enough
 * to collide with normal prose makes every message a parse candidate.
 */
function prefix(env) {
    const value = optionalString(env, "COMMAND_PREFIX", DEFAULTS.COMMAND_PREFIX);
    if (/\s/.test(value)) throw new ConfigError("COMMAND_PREFIX must not contain whitespace.");
    if (value.length > 8) throw new ConfigError("COMMAND_PREFIX must be 8 characters or fewer.");
    return value;
}

/**
 * @param {Record<string, string|undefined>} env explicit, never `process.env` —
 * only the composition root is allowed to read the ambient environment.
 */
export function loadConfig(env) {
    if (!env || typeof env !== "object") throw new ConfigError("loadConfig requires an environment object.");

    const logLevel = optionalString(env, "LOG_LEVEL", DEFAULTS.LOG_LEVEL).toLowerCase();
    if (!LOG_LEVELS.has(logLevel)) {
        throw new ConfigError(`LOG_LEVEL must be one of ${[...LOG_LEVELS].join(", ")}, got "${logLevel}".`);
    }

    return Object.freeze({
        token: requiredString(env, "DISCORD_TOKEN"),
        // Optional: nothing at runtime reads it. It is documented because
        // building the invite URL needs it, but a process that does not use a
        // value must not refuse to start without one. See ADR 0006.
        clientId: snowflake(env, "DISCORD_CLIENT_ID"),
        prefix: prefix(env),
        apiBaseUrl: httpsUrl(env, "API_BASE_URL", DEFAULTS.API_BASE_URL),
        guildAllowlist: snowflakeList(env, "GUILD_ALLOWLIST", "guild ID"),
        channelAllowlist: snowflakeList(env, "CHANNEL_ALLOWLIST", "channel ID"),
        logLevel,
        ffmpegPath: optionalString(env, "FFMPEG_PATH"),
        ytDlpPath: optionalString(env, "YT_DLP_PATH", "yt-dlp"),
        idleDisconnectMs: integer(env, "IDLE_DISCONNECT_MS", DEFAULTS.IDLE_DISCONNECT_MS, {
            min: 5_000,
            max: 3_600_000,
        }),
        apiTimeoutMs: integer(env, "API_TIMEOUT_MS", DEFAULTS.API_TIMEOUT_MS, { min: 1_000, max: 120_000 }),
        apiRetries: integer(env, "API_RETRIES", DEFAULTS.API_RETRIES, { min: 1, max: 10 }),
        defaultVolume: integer(env, "DEFAULT_VOLUME", DEFAULTS.DEFAULT_VOLUME, { min: 0, max: 200 }),
        radioPollMs: integer(env, "RADIO_POLL_MS", DEFAULTS.RADIO_POLL_MS, { min: 5_000, max: 120_000 }),
        test: Object.freeze({
            guildId: snowflake(env, "TEST_GUILD_ID"),
            voiceChannelId: snowflake(env, "TEST_VOICE_CHANNEL_ID"),
            guildId2: snowflake(env, "TEST_GUILD_ID_2"),
            voiceChannelId2: snowflake(env, "TEST_VOICE_CHANNEL_ID_2"),
        }),
    });
}

/** Values that must never reach a log line. Registered with the logger at startup. */
export function secretsOf(config) {
    return [config.token].filter(Boolean);
}

export { DEFAULTS };
