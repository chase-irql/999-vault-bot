import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Enforces the forbidden-coupling rules from docs/architecture.md by parsing
 * import statements. These are architecture rules, so they are checked the same
 * way behaviour is: with a test that fails.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

async function sourceFiles() {
    const entries = await readdir(srcDir, { withFileTypes: true, recursive: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
        .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

const files = await sourceFiles();
const sources = new Map(
    await Promise.all(files.map(async (file) => [path.relative(srcDir, file).replaceAll("\\", "/"), await readFile(file, "utf8")]))
);

/** Static `import ... from "x"`, side-effect `import "x"`, and dynamic `import("x")`. */
function importsOf(code) {
    const specifiers = [];
    const patterns = [
        /import\s+[^;'"]*?from\s*["']([^"']+)["']/g,
        /import\s*["']([^"']+)["']/g,
        /import\s*\(\s*["']([^"']+)["']\s*\)/g,
        /require\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) specifiers.push(match[1]);
    }
    return specifiers;
}

/** Resolves a relative specifier to a src-relative path for rule matching. */
function resolveSpecifier(fromFile, specifier) {
    if (!specifier.startsWith(".")) return specifier;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    return resolved;
}

describe("import boundaries", () => {
    test("every source file was found", () => {
        assert.ok(sources.size >= 10, `expected the src tree, found ${sources.size} files`);
    });

    test("commands do not reach into voice, HTTP, or the audio source", () => {
        const banned = [
            "@discordjs/voice",
            "undici",
            "node:fetch",
            "node:http",
            "node:https",
            "audio/source.js",
            "api/client.js",
        ];
        for (const [file, code] of sources) {
            if (!file.startsWith("bot/commands/")) continue;
            for (const specifier of importsOf(code)) {
                const resolved = resolveSpecifier(file, specifier);
                for (const bad of banned) {
                    assert.ok(
                        !resolved.includes(bad),
                        `${file} imports "${specifier}" — commands reach services through ctx.deps, not directly`
                    );
                }
            }
        }
    });

    test("commands do not import discord.js", () => {
        for (const [file, code] of sources) {
            if (!file.startsWith("bot/commands/")) continue;
            assert.ok(
                !importsOf(code).includes("discord.js"),
                `${file} imports discord.js — commands are surface-agnostic`
            );
        }
    });

    test("the api layer does not depend on the bot or the audio layer", () => {
        for (const [file, code] of sources) {
            if (!file.startsWith("api/")) continue;
            for (const specifier of importsOf(code)) {
                const resolved = resolveSpecifier(file, specifier);
                assert.ok(
                    !resolved.startsWith("bot/") && !resolved.startsWith("audio/"),
                    `${file} imports "${specifier}" — data flows one direction only`
                );
            }
        }
    });

    test("pure modules stay pure", () => {
        const pureModules = ["core/queue.js", "api/search.js", "api/normalize.js", "bot/embeds.js", "bot/router.js"];
        const bannedImports = [
            "discord.js",
            "@discordjs/voice",
            "prism-media",
            "node:fs",
            "node:fs/promises",
            "node:child_process",
            "node:http",
            "node:https",
            "node:timers",
            "node:timers/promises",
            "undici",
        ];
        for (const module of pureModules) {
            const code = sources.get(module);
            if (code === undefined) continue; // module not built yet
            for (const specifier of importsOf(code)) {
                assert.ok(
                    !bannedImports.includes(specifier),
                    `${module} imports "${specifier}" — it must stay pure and offline-testable`
                );
            }
            assert.ok(!/\bsetTimeout\s*\(/.test(code), `${module} uses setTimeout — pure modules take no timers`);
            assert.ok(!/\bsetInterval\s*\(/.test(code), `${module} uses setInterval — pure modules take no timers`);
            assert.ok(!/Math\.random\s*\(/.test(code), `${module} uses Math.random — inject the RNG instead`);
            assert.ok(!/\bfetch\s*\(/.test(code), `${module} calls fetch — pure modules do no I/O`);
        }
    });

    test("only the logger writes to the console", () => {
        for (const [file, code] of sources) {
            if (file === "core/logger.js") continue;
            const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
            assert.ok(
                !/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/.test(withoutComments),
                `${file} calls console.* — every output goes through core/logger.js`
            );
        }
    });

    test("only the composition root reads process.env", () => {
        const allowed = new Set(["index.js"]);
        for (const [file, code] of sources) {
            if (allowed.has(file)) continue;
            const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
            assert.ok(
                !/process\.env\b/.test(withoutComments),
                `${file} reads process.env — configuration is injected, not looked up`
            );
        }
    });
});
