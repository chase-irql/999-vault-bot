/**
 * JSON-line logger. The only module in the codebase permitted to call console.*
 * (enforced by test/boundaries.test.mjs).
 *
 * Redaction runs on every value before it is written, not at call sites, so a
 * token cannot leak through a field somebody forgot to sanitize.
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/**
 * Discord bot tokens: base64 client id (starting M/N/O), a timestamp chunk, and
 * an HMAC. Matches both the legacy 59-char and current longer forms.
 */
const TOKEN_PATTERN = /[MNO][A-Za-z\d_-]{23,}\.[\w-]{6}\.[\w-]{27,}/g;

const REDACTED = "[redacted]";

/** Literal strings registered at startup so config values are scrubbed even if reshaped. */
const literalSecrets = new Set();

export function registerSecret(value) {
    if (typeof value === "string" && value.length >= 8) literalSecrets.add(value);
}

/** Exposed for tests; clears registered literals so cases do not bleed. */
export function clearSecrets() {
    literalSecrets.clear();
}

export function redactString(input) {
    let output = String(input).replace(TOKEN_PATTERN, REDACTED);
    for (const secret of literalSecrets) {
        if (secret && output.includes(secret)) output = output.split(secret).join(REDACTED);
    }
    return output;
}

/** Deep-redacts a value, flattening Errors and dropping cycles. */
export function redact(value, seen = new WeakSet()) {
    if (typeof value === "string") return redactString(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactString(value.message),
            code: value.code,
            stack: value.stack ? redactString(value.stack) : undefined,
            cause: value.cause ? redact(value.cause, seen) : undefined,
        };
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, seen));

    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = redact(item, seen);
    return output;
}

export function createLogger({ level = "info", name = "bot", write, clock = Date } = {}) {
    const threshold = LEVELS[level] ?? LEVELS.info;
    // Bound once so the boundary test sees a single console call site.
    const sink = write ?? ((line) => console.log(line));

    const emit = (levelName, message, fields) => {
        if (LEVELS[levelName] < threshold) return;
        const record = {
            time: new Date(clock.now()).toISOString(),
            level: levelName,
            name,
            msg: redactString(message),
            ...(fields ? redact(fields) : {}),
        };
        sink(JSON.stringify(record));
    };

    const logger = {
        level,
        debug: (message, fields) => emit("debug", message, fields),
        info: (message, fields) => emit("info", message, fields),
        warn: (message, fields) => emit("warn", message, fields),
        error: (message, fields) => emit("error", message, fields),
        /** Child logger that stamps every record with extra context. */
        child(bindings = {}) {
            const wrap = (levelName) => (message, fields) =>
                emit(levelName, message, { ...bindings, ...fields });
            return {
                level,
                debug: wrap("debug"),
                info: wrap("info"),
                warn: wrap("warn"),
                error: wrap("error"),
                child: (more) => logger.child({ ...bindings, ...more }),
            };
        },
    };
    return logger;
}

export { LEVELS };
