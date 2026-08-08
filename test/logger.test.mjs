import assert from "node:assert/strict";
import test, { describe, beforeEach } from "node:test";
import { clearSecrets, createLogger, redact, redactString, registerSecret } from "../src/core/logger.js";
import { fakeClock } from "./helpers/context.mjs";

/**
 * Shaped like a real Discord token but not one — only the shape is under test.
 *
 * Assembled from parts on purpose: written as a single literal it would match
 * scripts/check-secrets.mjs and block every commit that touches this file. The
 * fix is to keep no token-shaped literal in the tree, not to add an exception to
 * the scanner.
 */
const TOKEN_SHAPED = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GaBcDe", "abcdefghijklmnopqrstuvwxyz1234567890"].join(".");

function capture(options = {}) {
    const lines = [];
    const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)), clock: fakeClock(), ...options });
    return { logger, lines };
}

beforeEach(() => clearSecrets());

describe("redaction", () => {
    test("removes anything shaped like a bot token", () => {
        assert.equal(redactString(TOKEN_SHAPED), "[redacted]");
        assert.equal(redactString(`Bearer ${TOKEN_SHAPED} trailing`), "Bearer [redacted] trailing");
    });

    test("removes registered literal secrets even when reshaped", () => {
        registerSecret("super-secret-value");
        assert.equal(redactString("token=super-secret-value"), "token=[redacted]");
    });

    test("ignores short registered values so it cannot redact everything", () => {
        registerSecret("ab");
        assert.equal(redactString("ab cd"), "ab cd");
    });

    test("walks nested objects and arrays", () => {
        const result = redact({ a: { b: [TOKEN_SHAPED, "safe"] } });
        assert.deepEqual(result, { a: { b: ["[redacted]", "safe"] } });
    });

    test("flattens errors and redacts their message and stack", () => {
        const error = new Error(`login failed for ${TOKEN_SHAPED}`);
        const result = redact({ error });
        assert.equal(result.error.message, "login failed for [redacted]");
        assert.ok(!result.error.stack.includes(TOKEN_SHAPED));
    });

    test("survives circular references", () => {
        const node = { name: "a" };
        node.self = node;
        assert.deepEqual(redact(node), { name: "a", self: "[circular]" });
    });

    test("leaves non-string primitives alone", () => {
        assert.deepEqual(redact({ n: 1, b: true, z: null }), { n: 1, b: true, z: null });
    });
});

describe("logger", () => {
    test("writes one JSON object per line", () => {
        const { logger, lines } = capture();
        logger.info("hello", { guildId: "123" });
        assert.equal(lines.length, 1);
        assert.equal(lines[0].level, "info");
        assert.equal(lines[0].msg, "hello");
        assert.equal(lines[0].guildId, "123");
        assert.match(lines[0].time, /^\d{4}-\d{2}-\d{2}T/);
    });

    test("suppresses records below the configured level", () => {
        const { logger, lines } = capture({ level: "warn" });
        logger.debug("no");
        logger.info("no");
        logger.warn("yes");
        logger.error("yes");
        assert.deepEqual(lines.map((line) => line.level), ["warn", "error"]);
    });

    test("silent suppresses everything", () => {
        const { logger, lines } = capture({ level: "silent" });
        logger.error("dropped");
        assert.equal(lines.length, 0);
    });

    test("redacts the message and every field", () => {
        const { logger, lines } = capture();
        logger.error(`failed with ${TOKEN_SHAPED}`, { token: TOKEN_SHAPED, nested: { t: TOKEN_SHAPED } });
        assert.ok(!JSON.stringify(lines[0]).includes(TOKEN_SHAPED));
    });

    test("child loggers stamp their bindings on every record", () => {
        const { logger, lines } = capture();
        const child = logger.child({ module: "api" }).child({ guildId: "9" });
        child.info("request");
        assert.equal(lines[0].module, "api");
        assert.equal(lines[0].guildId, "9");
    });

    test("call-site fields win over child bindings", () => {
        const { logger, lines } = capture();
        logger.child({ guildId: "1" }).info("x", { guildId: "2" });
        assert.equal(lines[0].guildId, "2");
    });
});
