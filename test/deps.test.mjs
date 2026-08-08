import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const allDependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
};

describe("dependency policy", () => {
    test("every dependency is pinned to an exact version", () => {
        for (const [name, range] of Object.entries(allDependencies)) {
            assert.ok(
                /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(range),
                `${name} is "${range}" — dependencies are pinned exactly, with no ^ or ~`
            );
        }
    });

    test("there are no dev dependencies", () => {
        assert.equal(
            Object.keys(manifest.devDependencies ?? {}).length,
            0,
            "the test runner and syntax gate are built into Node; nothing else is needed"
        );
    });

    test("the direct dependency budget is respected", () => {
        const count = Object.keys(allDependencies).length;
        assert.ok(count <= 8, `${count} direct dependencies, budget is 8`);
    });

    test("an opus implementation is always available", () => {
        // @discordjs/opus is optional because its prebuilds do not cover every
        // Node ABI; opusscript is a required pure-JS fallback so a fresh install
        // can always encode. See docs/decisions/0003-opus-fallback.md.
        assert.ok(manifest.optionalDependencies["@discordjs/opus"], "native opus must stay available");
        assert.ok(manifest.dependencies.opusscript, "the pure-JS opus fallback must be a hard dependency");
    });

    test("the forbidden dependency classes are absent", () => {
        const banned = [
            "dotenv",
            "winston",
            "pino",
            "bunyan",
            "zod",
            "joi",
            "yup",
            "express",
            "fastify",
            "koa",
            "sequelize",
            "prisma",
            "typeorm",
            "node-cron",
            "jest",
            "mocha",
            "vitest",
            "chai",
            "eslint",
            "prettier",
            "typescript",
        ];
        const declared = new Set([...Object.keys(allDependencies), ...Object.keys(manifest.devDependencies ?? {})]);
        for (const name of banned) {
            assert.ok(!declared.has(name), `${name} is declared — write the small amount of code it would replace`);
        }
    });

    test("discord.js is on a released v14, never a v15 dev build", () => {
        const version = manifest.dependencies["discord.js"];
        assert.ok(version.startsWith("14."), `discord.js is "${version}" — v15 is unreleased and unstable`);
        assert.ok(!version.includes("dev"), "discord.js must not use a dev dist-tag");
    });

    test("the package is ESM with no build step", () => {
        assert.equal(manifest.type, "module");
        assert.equal(manifest.scripts.build, undefined, "the entrypoint runs directly; there is no build");
    });

    test("the documented scripts exist", () => {
        for (const script of ["start", "dev", "verify", "verify:voice", "precommit"]) {
            assert.ok(manifest.scripts[script], `package.json is missing the "${script}" script`);
        }
    });

    test("engines requires a Node version that supports --env-file-if-exists", () => {
        assert.match(manifest.engines.node, /^>=22\.9\.0$/);
    });
});
