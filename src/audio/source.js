import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { StreamType, createAudioResource } from "@discordjs/voice";
import { VoiceError } from "../core/errors.js";

/**
 * Song (or radio stream) -> AudioResource.
 *
 * FFmpeg reads the HTTPS URL directly and writes raw PCM to stdout. YouTube
 * URLs are resolved when playback starts so queued tracks get fresh URLs.
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
 * @param {{ url: string, seekSeconds?: number, debug?: boolean, headers?: string, sectionStart?: number, sectionEnd?: number }} options
 * @returns {string[]} argv after the binary
 */
export function buildFfmpegArgs({ url, seekSeconds = 0, debug = false, headers = "", sectionStart, sectionEnd }) {
    const offset = Number.isFinite(sectionStart) ? sectionStart : 0;
    const seconds = Number(seekSeconds);
    const seek = offset + (Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0);
    const args = [...RECONNECT];

    // `-ss` before `-i` is input seeking: FFmpeg jumps using the container index
    // and a Range request instead of decoding and discarding everything first.
    if (seek > 0) args.push("-ss", String(seek));
    if (headers) args.push("-rw_timeout", "15000000", "-headers", headers);

    args.push("-i", url);
    if (Number.isFinite(sectionEnd)) args.push("-t", String(sectionEnd - seek));
    args.push("-analyzeduration", "0");

    // The brief specifies `-loglevel 0`, and it also requires FFmpeg's stderr to
    // be logged at debug when it exits non-zero. Those are contradictory: at
    // level 0 there is no stderr to log. Silent normally, diagnosable when the
    // operator has asked for debug.
    args.push("-loglevel", debug ? "error" : "0");

    args.push("-map", "0:a:0", ...RAW_PCM_OUTPUT, "pipe:1");
    return args;
}

/**
 * Spawns FFmpeg and wraps stdout in an AudioResource.
 *
 * @param {object} options
 * @param {string} options.ffmpegPath absolute path to the binary
 * @param {string} [options.url] HTTPS source
 * @param {(signal: AbortSignal) => Promise<object>} [options.resolveInput] Resolves a fresh HTTPS source
 * @param {number} [options.seekSeconds]
 * @param {object} [options.logger]
 * @param {(error: Error) => void} [options.onError] called when FFmpeg fails or exits non-zero
 * @returns {{ resource: import("@discordjs/voice").AudioResource, destroy: () => void }}
 */
export function createSource({
    ffmpegPath, url, resolveInput, seekSeconds = 0, logger = null, onError = null, metadata = null,
}) {
    const abort = new AbortController();
    let child;
    let settled = false;
    const fail = (error) => {
        if (settled) return;
        settled = true;
        onError?.(error);
    };

    function startDecoder(input) {
        if (!/^https:\/\//i.test(String(input.url))) {
            throw new VoiceError("Refusing to stream over an insecure connection.");
        }
        const debug = logger?.level === "debug";
        const args = buildFfmpegArgs({ ...input, seekSeconds, debug });
        child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

        let stderr = "";
        child.stderr.on("data", (chunk) => {
            if (stderr.length < 4_000) stderr += String(chunk).slice(0, 4_000 - stderr.length);
        });

        child.on("error", (error) => {
            logger?.error("ffmpeg failed to start", { code: error.code, ffmpegPath });
            fail(new VoiceError("The audio decoder could not start."));
        });

        child.on("close", (code, signal) => {
            if (signal || code === 0 || code === null || settled) return;
            logger?.debug("ffmpeg exited non-zero", {
                code,
                stderr: stderr.trim().replace(/https?:\/\/\S+/g, "[URL]").slice(0, 500),
            });
            fail(new VoiceError("The track stopped unexpectedly while decoding.", { code }));
        });
        return child.stdout;
    }

    let stream;
    if (resolveInput) {
        const output = new PassThrough();
        stream = output;
        void resolveInput(abort.signal).then((input) => {
            if (abort.signal.aborted) return;
            // Let FFmpeg report a failed exit before the player sees the end of the stream.
            startDecoder(input).pipe(output, { end: false });
            child.once("close", () => output.end());
        }).catch((error) => {
            if (abort.signal.aborted) return;
            fail(error);
            output.end();
        });
    } else {
        stream = startDecoder({ url });
    }

    const resource = createAudioResource(stream, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        metadata,
    });

    const destroy = () => {
        if (abort.signal.aborted) return;
        settled = true;
        abort.abort();
        stream.destroy();
        child?.stdout.destroy();
        child?.stderr.destroy();
        if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };

    return { resource, destroy };
}

export { RAW_PCM_OUTPUT, RECONNECT };
