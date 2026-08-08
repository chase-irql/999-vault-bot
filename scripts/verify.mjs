import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The single verification entrypoint. Runs in order and stops on the first
 * failure:
 *
 *   1. `node --check` over every source file — a zero-dependency syntax gate
 *      that catches a broken file before the test runner has to import it.
 *   2. `node --test test/` — Node's built-in runner. That suite includes the
 *      import-boundary test and the dependency-pin test, so those two checks
 *      run here too, in that order.
 *
 * There is no linter and no test framework on purpose: the dependency budget is
 * spent on things that make audio come out of a voice channel.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

async function collectSources(dir) {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
        .filter((entry) => entry.isFile() && /\.(mjs|js)$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

function step(name, run) {
    process.stdout.write(`\n── ${name}\n`);
    const started = Date.now();
    const okay = run();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (!okay) {
        process.stdout.write(`   FAILED (${seconds}s)\n`);
        process.exit(1);
    }
    process.stdout.write(`   ok (${seconds}s)\n`);
}

const files = (
    await Promise.all([
        collectSources(path.join(root, "src")),
        collectSources(path.join(root, "scripts")),
        collectSources(path.join(root, "test")),
    ])
).flat();

step(`syntax check (${files.length} files)`, () => {
    let clean = true;
    for (const file of files) {
        const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        if (result.status !== 0) {
            process.stdout.write(`   ${path.relative(root, file)}\n${result.stderr}`);
            clean = false;
        }
    }
    return clean;
});

// A bare `test/` argument is resolved as a module specifier by Node 26 and
// fails with MODULE_NOT_FOUND; the glob form is stable across 22/24/26 and also
// keeps test/helpers/ (which holds fixtures, not tests) out of the run.
const TEST_GLOB = "test/**/*.test.mjs";

step(`node --test ${TEST_GLOB}`, () => {
    const result = spawnSync(process.execPath, ["--test", TEST_GLOB], {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: "test" },
    });
    return result.status === 0;
});

process.stdout.write("\nverify: all checks passed\n");
