import { spawn } from "node:child_process";
import { StreamType, createAudioResource } from "@discordjs/voice";
import { VoiceError } from "../core/errors.js";

/**
 * Song (or radio stream) -> AudioResource.
 *
 * FFmpeg reads the HTTPS URL directly and writes raw PCM to stdout. Nothing is
 * downloaded to disk, nothing is buffered in memory, and no temp file is
 * written — the archive supports Range, so FFmpeg streams and seeks in place.
 *
 * Why the binary is spawned here rather than through `prism.FFmpeg`:
 * prism-media resolves its own command with a fixed search order
 * (`ffmpeg-static`, then `ffmpeg` on PATH, then `./ffmpeg`) and offers no way to
 * pass an explicit path. That makes `FFMPEG_PATH` unimplementable through it.
 * Since the requirement is to resolve the binary explicitly rather than trust
 * PATH, the process is spawned directly. prism-media remains a dependency —
 * `@discordjs/voice` uses it for Opus encoding. See docs/decisions/0005.
 */

const RAW_PCM_OUTPUT = ["-f", "s16le", "-ar", "48000", "-ac", "2"];

/**
 * Reconnect flags are input options and must precede `-i`. Without them a
 * transient TCP reset mid-track ends the stream and looks like the song simply
 * stopped.
 */
const RECONNECT = ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"];

/**
 * @param {{ url: string, seekSeconds?: number, debug?: boolean }} options
 * @returns {string[]} argv after the binary
 */
export function buildFfmpegArgs({ url, seekSeconds = 0, debug = false }) {
    const seek = Number(seekSeconds);
    const args = [...RECONNECT];

    // `-ss` before `-i` is input seeking: FFmpeg jumps using the container index
    // and a Range request instead of decoding and discarding everything first.
    if (Number.isFinite(seek) && seek > 0) args.push("-ss", String(Math.floor(seek)));

    args.push("-i", url);
    args.push("-analyzeduration", "0");

    // The brief specifies `-loglevel 0`, and it also requires FFmpeg's stderr to
    // be logged at debug when it exits non-zero. Those are contradictory: at
    // level 0 there is no stderr to log. Silent normally, diagnosable when the
    // operator has asked for debug.
    args.push("-loglevel", debug ? "error" : "0");

    args.push(...RAW_PCM_OUTPUT, "pipe:1");
    return args;
}

/**
 * Spawns FFmpeg and wraps stdout in an AudioResource.
 *
 * @param {object} options
 * @param {string} options.ffmpegPath absolute path to the binary
 * @param {string} options.url HTTPS source; cleartext is refused
 * @param {number} [options.seekSeconds]
 * @param {object} [options.logger]
 * @param {(error: Error) => void} [options.onError] called when FFmpeg fails or exits non-zero
 * @returns {{ resource: import("@discordjs/voice").AudioResource, destroy: () => void }}
 */
export function createSource({ ffmpegPath, url, seekSeconds = 0, logger = null, onError = null, metadata = null }) {
    if (!/^https:\/\//i.test(String(url))) {
        // Archive audio is never fetched over cleartext, including the station
        // URL the API hands back as http://.
        throw new VoiceError("Refusing to stream over an insecure connection.", { url: String(url).slice(0, 12) });
    }

    const debug = logger?.level === "debug";
    const args = buildFfmpegArgs({ url, seekSeconds, debug });
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let settled = false;
    const fail = (error) => {
        if (settled) return;
        settled = true;
        onError?.(error);
    };

    child.stderr?.on("data", (chunk) => {
        // Bounded: a chatty FFmpeg must not grow this without limit.
        if (stderr.length < 4_000) stderr += String(chunk);
    });

    child.on("error", (error) => {
        logger?.error("ffmpeg failed to start", { error, ffmpegPath });
        fail(new VoiceError("The audio decoder could not start.", { cause: error }));
    });

    child.on("close", (code, signal) => {
        // SIGKILL is how this module stops a source on skip or stop; that is not
        // a failure. A non-zero exit on its own is.
        if (signal || code === 0 || code === null) return;
        logger?.debug("ffmpeg exited non-zero", { code, stderr: stderr.trim().slice(0, 500) });
        fail(new VoiceError("The track stopped unexpectedly while decoding.", { code }));
    });

    const resource = createAudioResource(child.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        metadata,
    });

    let destroyed = false;
    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        settled = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };

    return { resource, destroy, process: child };
}

export { RAW_PCM_OUTPUT, RECONNECT };
