import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Staged-content secret scan. Run before every commit (`npm run precommit`).
 *
 * Scans what is actually staged rather than the working tree, because the
 * working tree legitimately contains a real `.env` and the point is to stop it
 * reaching a commit.
 */

const TOKEN_PATTERN = /[MNO][A-Za-z\d_-]{23,}\.[\w-]{6}\.[\w-]{27,}/;

/** The placeholder in .env.example is deliberately token-shaped; it is not a secret. */
const ALLOWED = [/MTA0000000000000000\.XXXXXX\.x{36}/];

function git(args) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) {
        process.stderr.write(`check-secrets: git ${args.join(" ")} failed\n${result.stderr}`);
        process.exit(1);
    }
    return result.stdout;
}

const failures = [];

const stagedFiles = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

for (const file of stagedFiles) {
    const base = file.split("/").pop();
    if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) {
        failures.push(`${file}: environment files must never be staged`);
    }
    if (/\.(mp3|wav|m4a|flac|opus|mp4|mkv|mov|webm)$/i.test(file)) {
        failures.push(`${file}: media files must not be committed`);
    }
}

// Added lines only: an existing false positive should not block every later commit.
const added = git(["diff", "--cached", "-U0"])
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));

for (const line of added) {
    const body = line.slice(1);
    if (!TOKEN_PATTERN.test(body)) continue;
    if (ALLOWED.some((pattern) => pattern.test(body))) continue;
    failures.push(`staged line matches the Discord token pattern: ${body.slice(0, 24)}…`);
}

// Oversized blobs: evidence binaries above 2 MB are not committed.
const sizes = git(["diff", "--cached", "--numstat"]);
void sizes;
for (const file of stagedFiles) {
    const size = spawnSync("git", ["cat-file", "-s", `:${file}`], { encoding: "utf8" });
    const bytes = Number(size.stdout.trim());
    if (Number.isFinite(bytes) && bytes > 2 * 1024 * 1024) {
        failures.push(`${file}: staged blob is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the 2 MB limit`);
    }
}

if (failures.length > 0) {
    process.stderr.write("check-secrets: refusing to commit\n");
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
}

process.stdout.write(`check-secrets: clean (${stagedFiles.length} staged files)\n`);
