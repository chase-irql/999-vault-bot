import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UserError, VoiceError } from "../core/errors.js";

const execFileAsync = promisify(execFile);
const YOUTUBE_HOST = /^(?:(?:www|m|music)\.)?youtube\.com$/;
const VIDEO_ID = /^[\w-]{11}$/;
const FORMAT = "bestaudio[protocol=https]/bestaudio[protocol^=m3u8]/best[protocol=https]/best[protocol^=m3u8]";
const FIELDS = "%(.{id,title,duration,thumbnail,live_status,section_start,section_end,url,http_headers})j";
const MEDIA_HEADERS = new Set(["user-agent", "referer", "origin", "accept", "accept-language", "sec-fetch-mode"]);

export function youtubeVideoUrl(query) {
    const input = query.replace(/^<(.+)>$/, "$1").replace(/^(["'])(.+)\1$/, "$2");
    const url = URL.parse(/^[\w.-]+\//.test(input) ? `https://${input}` : input);
    if (!url) return null;

    const host = url.hostname;
    const shortLink = host === "youtu.be" || host === "www.youtu.be";
    const privacyEmbed = host === "youtube-nocookie.com" || host === "www.youtube-nocookie.com";
    if (!shortLink && !privacyEmbed && !YOUTUBE_HOST.test(host)) return null;

    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || /\s/.test(input)) {
        throw new UserError("Paste a direct link to one YouTube video.");
    }

    const path = url.pathname.replace(/\/$/, "");
    if (!shortLink && !privacyEmbed && /^\/clip\/[\w-]+$/.test(path)) {
        return `https://www.youtube.com${path}`;
    }

    let id;
    if (shortLink) id = path.slice(1);
    else if (privacyEmbed) id = /^\/embed\/([\w-]+)$/.exec(path)?.[1];
    else if (["/watch", "/watch_popup", "/watch.php"].includes(path)) id = url.searchParams.get("v");
    else id = /^\/(?:shorts|live|embed|v|e)\/([\w-]+)$/.exec(path)?.[1];

    if (!VIDEO_ID.test(id ?? "")) throw new UserError("Paste a direct link to one YouTube video.");
    return `https://www.youtube.com/watch?v=${id}`;
}

function isYouTubeMedia(url) {
    const parsed = typeof url === "string" ? URL.parse(url) : null;
    return parsed?.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port &&
        (YOUTUBE_HOST.test(parsed.hostname) || /(?:^|\.)googlevideo\.com$/.test(parsed.hostname));
}

export function createYouTube({ ytDlpPath, nodePath, logger }) {
    async function extract(url, signal) {
        let stdout;
        try {
            ({ stdout } = await execFileAsync(ytDlpPath, [
                "--ignore-config", "--no-playlist", "--use-extractors", "youtube,youtube:clip",
                "--no-js-runtimes", "--js-runtimes", `node:${nodePath}`,
                "--socket-timeout", "8", "--retries", "1", "--extractor-retries", "1",
                "--simulate", "--format", FORMAT, "--print", FIELDS, "--", url,
            ], { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024, signal }));
        } catch (error) {
            if (signal?.aborted) throw error;
            if (error.code === "ENOENT" || error.code === "EACCES") {
                throw new VoiceError("YouTube playback is unavailable because yt-dlp could not start.", { code: error.code });
            }
            logger.debug("yt-dlp could not resolve video", {
                url,
                reason: String(error.stderr ?? "").split(/\r?\n/).find((line) => line.startsWith("ERROR:"))
                    ?.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 300),
                timedOut: error.killed === true,
            });
            if (error.killed) throw new VoiceError("YouTube took too long to respond. Try again in a moment.");
            throw new UserError("I could not open that video's audio on YouTube. Check that the video is available without signing in.");
        }

        let info;
        try {
            info = JSON.parse(stdout);
        } catch {
            throw new VoiceError("YouTube returned an unreadable audio response.");
        }
        if (!isYouTubeMedia(info?.url)) throw new VoiceError("YouTube did not provide a playable audio stream.");
        return info;
    }

    return {
        async resolveTrack(query) {
            const youtubeUrl = youtubeVideoUrl(query);
            if (!youtubeUrl) return null;
            const info = await extract(youtubeUrl);
            const isLive = info.live_status === "is_live";
            const thumbnail = typeof info.thumbnail === "string" ? URL.parse(info.thumbnail) : null;
            return {
                id: info.id,
                title: info.title || "YouTube video",
                durationSeconds: !isLive && Number.isFinite(info.duration) ? info.duration : null,
                imageUrl: thumbnail?.protocol === "https:" && /(?:^|\.)ytimg\.com$/.test(thumbnail.hostname)
                    ? thumbnail.href : "",
                youtubeUrl,
                isLive,
            };
        },

        async resolveInput(url, signal) {
            const info = await extract(url, signal);
            const headers = Object.entries(info.http_headers ?? {})
                .filter(([name, value]) => MEDIA_HEADERS.has(name.toLowerCase()) &&
                    typeof value === "string" && !/[\r\n\0]/.test(value))
                .map(([name, value]) => `${name}: ${value}\r\n`).join("");
            return {
                url: info.url,
                headers,
                sectionStart: info.section_start,
                sectionEnd: info.section_end,
            };
        },
    };
}
