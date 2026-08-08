/**
 * Error taxonomy. Every failure that crosses a module boundary is one of these.
 *
 * `userMessage` is the only text a command is allowed to show a Discord user.
 * It never contains a stack trace, a token, or an archive path, because those
 * either leak secrets or leak the archive layout into a public channel.
 */
export class AppError extends Error {
    constructor(message, { code = "APP_ERROR", userMessage = "", cause, ...details } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = new.target.name;
        this.code = code;
        this.userMessage = userMessage || message;
        this.details = details;
    }
}

/** Missing or malformed configuration. Always fatal at startup. */
export class ConfigError extends AppError {
    constructor(message, details = {}) {
        super(message, { code: "CONFIG", userMessage: message, ...details });
    }
}

/** The archive refused, timed out, or returned something unusable. */
export class ApiError extends AppError {
    constructor(message, details = {}) {
        super(message, {
            code: "API",
            userMessage: "The archive did not respond. Try again in a moment.",
            ...details,
        });
    }
}

/** A query could not be turned into exactly one song. */
export class ResolveError extends AppError {
    constructor(message, details = {}) {
        super(message, { code: "RESOLVE", userMessage: message, ...details });
    }
}

/** Joining, speaking in, or streaming to a voice channel failed. */
export class VoiceError extends AppError {
    constructor(message, details = {}) {
        super(message, { code: "VOICE", userMessage: message, ...details });
    }
}

/**
 * The user asked for something that cannot work — wrong arguments, not in a
 * voice channel, seeking the radio. Expected, not a defect; logged at debug.
 */
export class UserError extends AppError {
    constructor(message, details = {}) {
        super(message, { code: "USER", userMessage: message, ...details });
    }
}

/** True when the error is the user's to fix, so the bot should not log it as a fault. */
export function isUserFacing(error) {
    return error instanceof UserError || error instanceof ResolveError;
}

/** Message safe to put in front of a user, whatever the error turns out to be. */
export function userMessageFor(error) {
    if (error instanceof AppError) return error.userMessage;
    return "Something went wrong running that command.";
}
