import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { ConfigError } from "../core/errors.js";

const execFileAsync = promisify(execFile);

/**
 * FFmpeg discovery.
 *
 * FFmpeg is deliberately not assumed to be on PATH — it is not on the
 * development machine. `ffmpeg-static` ships a prebuilt binary and exports its
 * absolute path; `FFMPEG_PATH` overrides it for hosts with a system build.
 *
 * prism-media would otherwise probe PATH and then `ffmpeg-static`, but its
 * probe order is not something to depend on, so the path is resolved here and
 * handed to prism explicitly.
 */
export function resolveFfmpegPath(config) {
    if (config.ffmpegPath) {
        const explicit = path.resolve(config.ffmpegPath);
        if (!existsSync(explicit)) {
            throw new ConfigError(`FFMPEG_PATH points at "${explicit}", which does not exist.`);
        }
        return { path: explicit, source: "FFMPEG_PATH" };
    }
    if (typeof ffmpegStatic === "string" && ffmpegStatic && existsSync(ffmpegStatic)) {
        return { path: path.resolve(ffmpegStatic), source: "ffmpeg-static" };
    }
    throw new ConfigError(
        "No FFmpeg binary found. ffmpeg-static did not install a prebuild for this platform; " +
            "install FFmpeg and set FFMPEG_PATH to its absolute path."
    );
}

/** First line of `ffmpeg -version`, for the startup log. Never fatal. */
export async function ffmpegVersion(binaryPath) {
    try {
        const { stdout } = await execFileAsync(binaryPath, ["-version"], { timeout: 10_000 });
        return stdout.split("\n")[0]?.trim() ?? "unknown";
    } catch {
        return "unknown";
    }
}
