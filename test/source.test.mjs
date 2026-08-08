import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { RAW_PCM_OUTPUT, buildFfmpegArgs } from "../src/audio/source.js";

/**
 * FFmpeg argument construction. Pure, so the exact argv can be asserted without
 * spawning anything — and argument *order* matters here in ways that are easy to
 * get subtly wrong and hard to notice at runtime.
 */

const URL = "https://juicewrldapi.com/juicewrld/files/download/?path=a.mp3";

const indexOf = (args, flag) => args.indexOf(flag);

describe("buildFfmpegArgs", () => {
    test("streams the URL directly, with no temp file and no download step", () => {
        const args = buildFfmpegArgs({ url: URL });
        assert.equal(args[indexOf(args, "-i") + 1], URL);
        assert.ok(args.includes("pipe:1"), "output goes to stdout");
    });

    test("emits raw 48 kHz stereo PCM, which is what the voice layer expects", () => {
        const args = buildFfmpegArgs({ url: URL });
        for (const flag of RAW_PCM_OUTPUT) assert.ok(args.includes(flag), `missing ${flag}`);
        assert.equal(args[indexOf(args, "-f") + 1], "s16le");
        assert.equal(args[indexOf(args, "-ar") + 1], "48000");
        assert.equal(args[indexOf(args, "-ac") + 1], "2");
    });

    test("reconnect flags come before -i, or FFmpeg ignores them", () => {
        const args = buildFfmpegArgs({ url: URL });
        const input = indexOf(args, "-i");
        for (const flag of ["-reconnect", "-reconnect_streamed", "-reconnect_delay_max"]) {
            assert.ok(indexOf(args, flag) >= 0, `missing ${flag}`);
            assert.ok(indexOf(args, flag) < input, `${flag} must precede -i`);
        }
        assert.equal(args[indexOf(args, "-reconnect_delay_max") + 1], "5");
    });

    test("skips analysis so playback starts fast", () => {
        const args = buildFfmpegArgs({ url: URL });
        assert.equal(args[indexOf(args, "-analyzeduration") + 1], "0");
    });

    test("no seek offset is emitted when starting from the beginning", () => {
        assert.equal(buildFfmpegArgs({ url: URL }).includes("-ss"), false);
        assert.equal(buildFfmpegArgs({ url: URL, seekSeconds: 0 }).includes("-ss"), false);
    });

    test("-ss goes before -i, so seeking uses the index rather than decoding to the point", () => {
        const args = buildFfmpegArgs({ url: URL, seekSeconds: 90 });
        assert.ok(indexOf(args, "-ss") < indexOf(args, "-i"), "input seeking, not output seeking");
        assert.equal(args[indexOf(args, "-ss") + 1], "90");
    });

    test("a fractional or negative seek is normalized rather than passed through", () => {
        assert.equal(buildFfmpegArgs({ url: URL, seekSeconds: 90.7 })[indexOf(buildFfmpegArgs({ url: URL, seekSeconds: 90.7 }), "-ss") + 1], "90");
        assert.equal(buildFfmpegArgs({ url: URL, seekSeconds: -5 }).includes("-ss"), false);
        assert.equal(buildFfmpegArgs({ url: URL, seekSeconds: Number.NaN }).includes("-ss"), false);
    });

    test("is silent normally and diagnosable at debug", () => {
        // -loglevel 0 as specified, but stderr has to exist for the debug-level
        // requirement to mean anything.
        const quiet = buildFfmpegArgs({ url: URL });
        assert.equal(quiet[indexOf(quiet, "-loglevel") + 1], "0");

        const loud = buildFfmpegArgs({ url: URL, debug: true });
        assert.equal(loud[indexOf(loud, "-loglevel") + 1], "error");
    });

    test("the argument list has no undefined or empty entries", () => {
        for (const args of [buildFfmpegArgs({ url: URL }), buildFfmpegArgs({ url: URL, seekSeconds: 12, debug: true })]) {
            for (const arg of args) {
                assert.equal(typeof arg, "string");
                assert.notEqual(arg, "");
            }
        }
    });
});
