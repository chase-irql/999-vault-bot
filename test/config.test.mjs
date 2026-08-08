import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { loadConfig } from "../src/config.js";
import { ConfigError } from "../src/core/errors.js";

const VALID = Object.freeze({
    DISCORD_TOKEN: "test-token-value-not-a-real-token",
    DISCORD_CLIENT_ID: "1040000000000000000",
});

const env = (overrides = {}) => ({ ...VALID, ...overrides });

describe("loadConfig", () => {
    test("applies documented defaults", () => {
        const config = loadConfig(env());
        assert.equal(config.prefix, "jw!");
        assert.equal(config.apiBaseUrl, "https://juicewrldapi.com/juicewrld");
        assert.equal(config.logLevel, "info");
        assert.equal(config.idleDisconnectMs, 300_000);
        assert.equal(config.apiTimeoutMs, 30_000);
        assert.equal(config.apiRetries, 4);
        assert.equal(config.defaultVolume, 100);
        assert.equal(config.radioPollMs, 15_000);
        assert.deepEqual(config.guildAllowlist, []);
    });

    test("returns a frozen object", () => {
        const config = loadConfig(env());
        assert.throws(() => {
            config.prefix = "x!";
        });
    });

    test("requires the token", () => {
        assert.throws(() => loadConfig(env({ DISCORD_TOKEN: "" })), ConfigError);
        assert.throws(() => loadConfig({ DISCORD_CLIENT_ID: VALID.DISCORD_CLIENT_ID }), /DISCORD_TOKEN is required/);
    });

    test("requires a well-formed client id", () => {
        assert.throws(() => loadConfig(env({ DISCORD_CLIENT_ID: "" })), /DISCORD_CLIENT_ID is required/);
        assert.throws(() => loadConfig(env({ DISCORD_CLIENT_ID: "abc" })), /must be a Discord ID/);
        assert.throws(() => loadConfig(env({ DISCORD_CLIENT_ID: "123" })), /must be a Discord ID/);
    });

    test("parses a guild allowlist and drops duplicates", () => {
        const config = loadConfig(
            env({ GUILD_ALLOWLIST: " 1040000000000000001, 1040000000000000002 ,1040000000000000001 " })
        );
        assert.deepEqual(config.guildAllowlist, ["1040000000000000001", "1040000000000000002"]);
    });

    test("defaults the channel allowlist to empty, meaning every channel", () => {
        assert.deepEqual(loadConfig(env()).channelAllowlist, []);
    });

    test("parses a channel allowlist", () => {
        const config = loadConfig(env({ CHANNEL_ALLOWLIST: "1040000000000000010,1040000000000000011" }));
        assert.deepEqual(config.channelAllowlist, ["1040000000000000010", "1040000000000000011"]);
    });

    test("rejects a malformed channel allowlist entry, naming it a channel", () => {
        assert.throws(() => loadConfig(env({ CHANNEL_ALLOWLIST: "not-an-id" })), /not a Discord channel ID/);
    });

    test("rejects a malformed allowlist entry", () => {
        assert.throws(() => loadConfig(env({ GUILD_ALLOWLIST: "1040000000000000001,nope" })), /not a Discord guild ID/);
    });

    test("the two allowlists are independent", () => {
        const config = loadConfig(env({ GUILD_ALLOWLIST: "1040000000000000001", CHANNEL_ALLOWLIST: "1040000000000000010" }));
        assert.deepEqual(config.guildAllowlist, ["1040000000000000001"]);
        assert.deepEqual(config.channelAllowlist, ["1040000000000000010"]);
    });

    test("rejects a non-https archive URL", () => {
        assert.throws(() => loadConfig(env({ API_BASE_URL: "http://juicewrldapi.com/juicewrld" })), /must use https/);
        assert.throws(() => loadConfig(env({ API_BASE_URL: "not a url" })), /must be an absolute URL/);
    });

    test("strips a trailing slash from the archive URL", () => {
        assert.equal(loadConfig(env({ API_BASE_URL: "https://example.com/api/" })).apiBaseUrl, "https://example.com/api");
    });

    test("rejects a prefix with whitespace or excessive length", () => {
        assert.throws(() => loadConfig(env({ COMMAND_PREFIX: "jw !" })), /must not contain whitespace/);
        assert.throws(() => loadConfig(env({ COMMAND_PREFIX: "averylongprefix" })), /8 characters or fewer/);
    });

    test("validates log level", () => {
        assert.equal(loadConfig(env({ LOG_LEVEL: "DEBUG" })).logLevel, "debug");
        assert.throws(() => loadConfig(env({ LOG_LEVEL: "verbose" })), /LOG_LEVEL must be one of/);
    });

    test("rejects non-numeric and out-of-range numbers", () => {
        assert.throws(() => loadConfig(env({ API_RETRIES: "many" })), /must be a whole number/);
        assert.throws(() => loadConfig(env({ API_RETRIES: "0" })), /must be between 1 and 10/);
        assert.throws(() => loadConfig(env({ DEFAULT_VOLUME: "500" })), /must be between 0 and 200/);
        assert.throws(() => loadConfig(env({ IDLE_DISCONNECT_MS: "10" })), /must be between/);
    });

    test("accepts optional voice-test ids and rejects malformed ones", () => {
        const config = loadConfig(env({ TEST_GUILD_ID: "1040000000000000009" }));
        assert.equal(config.test.guildId, "1040000000000000009");
        assert.equal(config.test.voiceChannelId, "");
        assert.throws(() => loadConfig(env({ TEST_VOICE_CHANNEL_ID: "12" })), /must be a Discord ID/);
    });
});
