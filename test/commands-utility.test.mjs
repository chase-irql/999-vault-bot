import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createRegistry } from "../src/bot/commands/index.js";
import { parseCommand } from "../src/bot/router.js";
import { UserError } from "../src/core/errors.js";
import { createContext, embedText, lastEmbed } from "./helpers/context.mjs";

const registry = createRegistry();
const run = (name, options) => registry.find(name).execute(createContext({ commandName: name, ...options }));

describe("command registry", () => {
    test("resolves commands by name and by alias", () => {
        assert.equal(registry.find("help").name, "help");
        assert.equal(registry.find("h").name, "help");
        assert.equal(registry.find("commands").name, "help");
        assert.equal(registry.find("HELP").name, "help");
        assert.equal(registry.find("nonsense"), null);
    });

    test("every command declares the fields help generation depends on", () => {
        for (const command of registry.list()) {
            assert.equal(typeof command.name, "string", "name");
            assert.ok(Array.isArray(command.aliases), `${command.name}.aliases`);
            assert.ok(command.description.length > 0, `${command.name}.description`);
            assert.ok(command.usage.includes("{prefix}"), `${command.name}.usage must template the prefix`);
            assert.equal(typeof command.execute, "function", `${command.name}.execute`);
            assert.equal(command.name, command.name.toLowerCase(), `${command.name} must be lowercase`);
        }
    });

    test("no command carries a slash-option spec", () => {
        // The slash surface was removed (ADR 0006). `options` existed only to
        // generate application-command JSON and was never read by prefix
        // parsing; a leftover field invites someone to wire it back up.
        for (const command of registry.list()) {
            assert.equal(command.options, undefined, `${command.name} still declares options`);
        }
    });

    test("names and aliases do not collide", () => {
        const seen = new Set();
        for (const command of registry.list()) {
            for (const key of [command.name, ...command.aliases]) {
                assert.ok(!seen.has(key), `duplicate command key "${key}"`);
                seen.add(key);
            }
        }
    });

    test("every command is reachable through the prefix router", () => {
        // The router is now the only path in, so every registered name and alias
        // must survive a round trip through it.
        for (const command of registry.list()) {
            for (const key of [command.name, ...command.aliases]) {
                const parsed = parseCommand(`jw!${key} some args`, "jw!");
                assert.ok(parsed, `jw!${key} did not parse`);
                assert.equal(registry.find(parsed.name)?.name, command.name, `jw!${key} routed elsewhere`);
            }
        }
    });
});

describe("help", () => {
    test("lists every command, generated from the registry", async () => {
        const ctx = createContext({ commandName: "help" });
        await registry.find("help").execute(ctx);
        const text = embedText(lastEmbed(ctx));
        for (const command of registry.list()) {
            assert.ok(text.includes(`jw!${command.name}`), `help omits ${command.name}`);
        }
    });

    test("explains a single command by name or alias", async () => {
        const ctx = createContext({ commandName: "help", args: ["h"], rest: "h" });
        await registry.find("help").execute(ctx);
        const embed = lastEmbed(ctx);
        assert.equal(embed.title, "jw!help");
        const text = embedText(embed);
        assert.ok(text.includes("jw!h"), "should list the aliases");
        assert.ok(!text.includes("Slash"), "there is no slash surface to advertise");
    });

    test("rejects an unknown command with a useful message", async () => {
        await assert.rejects(() => run("help", { args: ["banana"], rest: "banana" }), (error) => {
            assert.ok(error instanceof UserError);
            assert.match(error.userMessage, /no `jw!banana` command/);
            return true;
        });
    });

    test("uses the configured prefix rather than a hard-coded one", async () => {
        const ctx = createContext({
            commandName: "help",
            deps: { config: { ...createContext().deps.config, prefix: "!!" } },
        });
        await registry.find("help").execute(ctx);
        assert.ok(embedText(lastEmbed(ctx)).includes("!!help"));
    });
});

describe("ping", () => {
    test("reports gateway, archive, memory, and uptime", async () => {
        const ctx = createContext({
            commandName: "ping",
            deps: { api: { health: async () => ({ status: "ok" }) } },
        });
        await registry.find("ping").execute(ctx);
        const embed = lastEmbed(ctx);
        assert.equal(embed.title, "Pong");
        const names = embed.fields.map((field) => field.name);
        assert.deepEqual(names, ["Gateway", "Archive /health/", "Memory (RSS)", "Uptime"]);
        assert.equal(embed.fields[0].value, "42 ms");
        assert.equal(embed.fields[2].value, "100 MB");
    });

    test("reports the archive as unreachable instead of throwing", async () => {
        const ctx = createContext({
            commandName: "ping",
            deps: {
                api: {
                    health: async () => {
                        throw new Error("ECONNREFUSED");
                    },
                },
            },
        });
        await registry.find("ping").execute(ctx);
        const embed = lastEmbed(ctx);
        assert.equal(embed.fields[1].value, "unreachable");
        assert.notEqual(embed.color, 0x22c55e);
    });
});
