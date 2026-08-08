/**
 * Pure prefix parsing: (content, prefix) -> { name, args, rest } | null.
 *
 * No discord.js, no I/O. The bot-author check lives here as an option so the
 * "ignore other bots" rule is testable without a gateway.
 */

/**
 * Splits on whitespace but keeps "double quoted" and 'single quoted' runs
 * together, so `jw!play "bad day"` is one argument.
 */
export function tokenize(input) {
    const tokens = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match;
    while ((match = pattern.exec(String(input ?? ""))) !== null) {
        const token = match[1] ?? match[2] ?? match[3];
        if (token !== "") tokens.push(token);
    }
    return tokens;
}

/**
 * @param {string} content raw message content
 * @param {string} prefix configured prefix, matched case-insensitively
 * @param {{ isBot?: boolean }} [options]
 * @returns {{ name: string, args: string[], rest: string } | null}
 */
export function parseCommand(content, prefix, { isBot = false } = {}) {
    if (isBot) return null;
    if (typeof content !== "string" || typeof prefix !== "string" || prefix === "") return null;

    const trimmed = content.trim();
    if (trimmed.length <= prefix.length) return null;
    if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;

    // Everything after the prefix; leading spaces let `jw! play` work too.
    const body = trimmed.slice(prefix.length).trim();
    if (!body) return null;

    const firstBreak = body.search(/\s/);
    const name = (firstBreak === -1 ? body : body.slice(0, firstBreak)).toLowerCase();
    if (!name) return null;

    const rest = firstBreak === -1 ? "" : body.slice(firstBreak).trim();
    return { name, args: tokenize(rest), rest };
}
