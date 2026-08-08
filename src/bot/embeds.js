/**
 * Every embed in the bot is built here, as pure functions returning plain
 * APIEmbed objects. No discord.js import, no I/O, no clock, no randomness —
 * which is what makes the presentation layer unit-testable.
 *
 * Two rules this module exists to enforce:
 *   1. Nothing leaves here longer than Discord's limits, so an oversized
 *      archive field can never turn into a 400 from the API.
 *   2. Archive-sourced text is markdown-escaped. The archive genuinely contains
 *      `*`, `_` and backticks in titles.
 *
 * Note: no builder here accepts or renders lyric text. Lyrics are excluded from
 * the canonical Song shape upstream, in api/normalize.js.
 */

export const COLORS = Object.freeze({
    playback: 0x8b5cf6,
    radio: 0xe11d48,
    error: 0xef4444,
    info: 0x64748b,
    success: 0x22c55e,
});

export const LIMITS = Object.freeze({
    title: 256,
    description: 4096,
    fieldName: 256,
    fieldValue: 1024,
    footer: 2048,
    authorName: 256,
    fields: 25,
    embeds: 10,
});

const MARKDOWN = /([\\*_~`|>])/g;

/** Escapes the characters that would otherwise break embed formatting. */
export function escapeMarkdown(value) {
    if (typeof value !== "string") return "";
    return value.replace(MARKDOWN, "\\$1");
}

/** Hard-clamps to `max`, leaving an ellipsis so truncation is visible rather than silent. */
export function clamp(value, max) {
    const text = typeof value === "string" ? value : String(value ?? "");
    if (text.length <= max) return text;
    if (max <= 1) return text.slice(0, max);
    return `${text.slice(0, max - 1)}…`;
}

/** Archive text, made safe for an embed in one step. */
function safe(value, max) {
    return clamp(escapeMarkdown(value), max);
}

/** `null`/unknown renders as `--:--`, never `NaN:NaN`. */
export function formatDuration(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined) return "--:--";
    const seconds = Number(totalSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function formatUptime(ms) {
    const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

const BAR_WIDTH = 20;

/**
 * 20-character bar. The ratio is clamped to [0, 1] so a station that reports an
 * elapsed value past its own duration cannot render a bar longer than the bar.
 */
export function progressBar(elapsedSeconds, totalSeconds, width = BAR_WIDTH) {
    const elapsed = Number(elapsedSeconds);
    const total = Number(totalSeconds);
    const usable = Number.isFinite(total) && total > 0;
    const ratio = usable && Number.isFinite(elapsed) ? Math.min(1, Math.max(0, elapsed / total)) : 0;
    const index = usable ? Math.min(width - 1, Math.floor(ratio * width)) : 0;
    const cells = new Array(width).fill("━");
    cells[index] = "⬤";
    return cells.join("");
}

export function percentOf(elapsedSeconds, totalSeconds) {
    const total = Number(totalSeconds);
    if (!Number.isFinite(total) || total <= 0) return 0;
    const ratio = (Number(elapsedSeconds) || 0) / total;
    return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

const CATEGORY_LABELS = Object.freeze({
    released: "Released",
    unreleased: "Unreleased",
    unsurfaced: "Unsurfaced",
    recording_session: "Recording session",
});

export function categoryLabel(category) {
    return CATEGORY_LABELS[category] ?? "Unknown";
}

/** Drops empty fields and enforces the 25-field ceiling. */
function fields(list) {
    return list
        .filter((field) => field && field.value !== "" && field.value !== null && field.value !== undefined)
        .slice(0, LIMITS.fields)
        .map((field) => ({
            name: clamp(field.name, LIMITS.fieldName),
            value: clamp(field.value, LIMITS.fieldValue),
            inline: Boolean(field.inline),
        }));
}

function base({ color, title, description, ...rest }) {
    const embed = { color };
    if (title !== undefined) embed.title = clamp(title, LIMITS.title);
    if (description !== undefined) embed.description = clamp(description, LIMITS.description);
    if (rest.author) embed.author = { name: clamp(rest.author, LIMITS.authorName) };
    if (rest.footer) embed.footer = { text: clamp(rest.footer, LIMITS.footer) };
    if (rest.thumbnail) embed.thumbnail = { url: rest.thumbnail };
    if (rest.fields) embed.fields = fields(rest.fields);
    return embed;
}

// --- Generic states -------------------------------------------------------

export function errorEmbed(title, description) {
    return base({ color: COLORS.error, title, description });
}

export function successEmbed(title, description) {
    return base({ color: COLORS.success, title, description });
}

export function infoEmbed(title, description) {
    return base({ color: COLORS.info, title, description });
}

// --- Utility commands -----------------------------------------------------

export function pingEmbed({ gatewayMs, archiveMs, archiveOk, rssMb, uptimeMs }) {
    const gateway = Number.isFinite(gatewayMs) && gatewayMs >= 0 ? `${Math.round(gatewayMs)} ms` : "unknown";
    const archive = archiveOk ? `${Math.round(archiveMs)} ms` : "unreachable";
    return base({
        color: archiveOk ? COLORS.success : COLORS.error,
        title: "Pong",
        fields: [
            { name: "Gateway", value: gateway, inline: true },
            { name: "Archive /health/", value: archive, inline: true },
            { name: "Memory (RSS)", value: `${rssMb} MB`, inline: true },
            { name: "Uptime", value: formatUptime(uptimeMs), inline: true },
        ],
    });
}

export function helpEmbed(commands, { prefix }) {
    const groups = new Map();
    for (const command of commands) {
        if (!groups.has(command.category)) groups.set(command.category, []);
        groups.get(command.category).push(command);
    }
    const grouped = [...groups.entries()].map(([category, list]) => ({
        name: category,
        value: list
            .map((command) => `\`${prefix}${command.name}\` — ${command.description}`)
            .join("\n"),
    }));

    return base({
        color: COLORS.info,
        title: "999 Vault commands",
        description:
            `Prefix \`${prefix}\` (case-insensitive) or the matching slash command. ` +
            `Use \`${prefix}help <command>\` for arguments.\n` +
            "Radio mode suspends the queue rather than clearing it; `radio stop` puts you back where you were.",
        fields: grouped,
        footer: "Archive: JuiceWRLDAPI.com · 999 Vault is an independent project",
    });
}

export function commandHelpEmbed(command, { prefix }) {
    return base({
        color: COLORS.info,
        title: `${prefix}${command.name}`,
        description: command.description,
        fields: [
            { name: "Usage", value: `\`${command.usage.replaceAll("{prefix}", prefix)}\`` },
            {
                name: "Aliases",
                value: command.aliases.length
                    ? command.aliases.map((alias) => `\`${prefix}${alias}\``).join(", ")
                    : "none",
            },
            { name: "Slash", value: `\`/${command.name}\`` },
            command.notes ? { name: "Notes", value: command.notes } : null,
        ],
    });
}

// --- Archive ---------------------------------------------------------------

/**
 * Metadata only. `lyrics` and `synced_lyrics` are not part of the Song shape,
 * so there is nothing here to accidentally print.
 */
export function songEmbed(song, { thumbnailUrl } = {}) {
    return base({
        color: COLORS.playback,
        author: "Archive entry",
        title: safe(song.title, LIMITS.title),
        description: song.aliases.length
            ? `Also known as: ${safe(song.aliases.slice(0, 6).join(" · "), 500)}`
            : undefined,
        thumbnail: thumbnailUrl || song.imageUrl || undefined,
        fields: [
            { name: "Era", value: safe(song.era?.name ?? "Unknown", 200), inline: true },
            { name: "Category", value: categoryLabel(song.category), inline: true },
            { name: "Duration", value: formatDuration(song.durationSeconds), inline: true },
            { name: "Artist", value: safe(song.artist, LIMITS.fieldValue), inline: true },
            { name: "Album", value: song.album ? safe(song.album, LIMITS.fieldValue) : "", inline: true },
            { name: "Leak type", value: song.leakType ? safe(song.leakType, LIMITS.fieldValue) : "", inline: true },
            { name: "Producers", value: song.producers ? safe(song.producers, LIMITS.fieldValue) : "" },
            { name: "Engineers", value: song.engineers ? safe(song.engineers, LIMITS.fieldValue) : "" },
            {
                name: "Recorded at",
                value: song.recordingLocations ? safe(song.recordingLocations, LIMITS.fieldValue) : "",
            },
        ],
        footer: `ID ${song.id}${song.publicId ? ` · public ${song.publicId}` : ""} · JuiceWRLDAPI.com`,
    });
}

function resultLine(index, song, prefix) {
    const duration = formatDuration(song.durationSeconds);
    const era = song.era?.name ? ` · ${safe(song.era.name, 40)}` : "";
    return (
        `\`${String(index).padStart(2, " ")}.\` **${safe(song.title, 120)}** \`${duration}\`\n` +
        `    ${categoryLabel(song.category)}${era} · \`${prefix}play ${song.id}\``
    );
}

export function searchEmbed(songs, { query, prefix, totalCount }) {
    return base({
        color: COLORS.playback,
        author: "Archive search",
        title: clamp(`Results for "${escapeMarkdown(query)}"`, LIMITS.title),
        description: songs.length
            ? songs.map((song, index) => resultLine(index + 1, song, prefix)).join("\n")
            : "Nothing matched.",
        footer: `${songs.length} shown${
            Number.isFinite(totalCount) ? ` of ${totalCount} matches` : ""
        } · JuiceWRLDAPI.com`,
    });
}

export function disambiguationEmbed(songs, { query, prefix, timeoutSeconds }) {
    return base({
        color: COLORS.info,
        author: "Which one?",
        title: clamp(`"${escapeMarkdown(query)}" matched several tracks`, LIMITS.title),
        description: songs.map((song, index) => resultLine(index + 1, song, prefix)).join("\n"),
        footer: `Reply with 1-${songs.length}, or use ${prefix}play <id>. Expires in ${timeoutSeconds}s.`,
    });
}

export function noResultsEmbed({ query, totalSongs, prefix }) {
    return base({
        color: COLORS.error,
        title: "No match in the archive",
        description:
            `Nothing matched **${safe(query, 200)}**.\n\n` +
            "The archive indexes alternate and working titles, so a track is often filed under a name " +
            `you would not expect. Try a different title, a lyric-free phrase from the name, or ` +
            `\`${prefix}search\` with a shorter query.`,
        footer: `${Number.isFinite(totalSongs) ? `${totalSongs} songs indexed` : "Archive"} · JuiceWRLDAPI.com`,
    });
}

export function statsEmbed({ stats, uptimeMs, guildCount, activePlayers, radioGuilds }) {
    const categories = Object.entries(stats?.categoryStats ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => `${categoryLabel(key)}: **${value}**`)
        .join("\n");
    const eras = Object.entries(stats?.eraStats ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([key, value]) => `${safe(key, 40)}: **${value}**`)
        .join("\n");

    return base({
        color: COLORS.info,
        author: "999 Vault",
        title: "Archive and bot status",
        fields: [
            { name: "Songs indexed", value: String(stats?.totalSongs ?? "unknown"), inline: true },
            { name: "Guilds", value: String(guildCount), inline: true },
            { name: "Active players", value: String(activePlayers), inline: true },
            { name: "In radio mode", value: String(radioGuilds ?? 0), inline: true },
            { name: "Uptime", value: formatUptime(uptimeMs), inline: true },
            { name: "By category", value: categories, inline: false },
            { name: "Largest eras", value: eras, inline: false },
        ],
        footer: "Archive source: JuiceWRLDAPI.com",
    });
}

// --- Playback --------------------------------------------------------------

const LOOP_LABELS = Object.freeze({ off: "Off", track: "Track", queue: "Queue" });

export function nowPlayingEmbed({
    song,
    elapsedSeconds,
    requesterId,
    paused = false,
    loopMode = "off",
    volume = 100,
    queueLength = 0,
}) {
    const total = song.durationSeconds;
    const bar = progressBar(elapsedSeconds, total);
    const position = `\`${formatDuration(elapsedSeconds)}\` ${bar} \`${formatDuration(total)}\``;

    return base({
        color: COLORS.playback,
        author: paused ? "Paused" : "Now playing",
        title: safe(song.title, LIMITS.title),
        description: position,
        thumbnail: song.imageUrl || undefined,
        fields: [
            { name: "Era", value: safe(song.era?.name ?? "Unknown", 200), inline: true },
            { name: "Category", value: categoryLabel(song.category), inline: true },
            { name: "Volume", value: `${volume}%`, inline: true },
            { name: "Loop", value: LOOP_LABELS[loopMode] ?? "Off", inline: true },
            { name: "Up next", value: queueLength > 0 ? `${queueLength} queued` : "Nothing queued", inline: true },
            { name: "Requested by", value: requesterId ? `<@${requesterId}>` : "unknown", inline: true },
        ],
        footer: "Archive source: JuiceWRLDAPI.com",
    });
}

export function queuedEmbed({ song, position, requesterId }) {
    return base({
        color: COLORS.success,
        author: position === 0 ? "Playing now" : `Queued at position ${position}`,
        title: safe(song.title, LIMITS.title),
        description: `\`${formatDuration(song.durationSeconds)}\` · ${categoryLabel(song.category)}${
            song.era?.name ? ` · ${safe(song.era.name, 60)}` : ""
        }`,
        thumbnail: song.imageUrl || undefined,
        footer: requesterId ? `Requested by ${requesterId}` : undefined,
    });
}

export function queueEmbed({ current, items, page, pageCount, pageSize, totalDurationSeconds, elapsedSeconds }) {
    const start = (page - 1) * pageSize;
    const lines = items.map((item, index) => {
        const position = String(start + index + 1).padStart(2, " ");
        return (
            `\`${position}.\` **${safe(item.song.title, 100)}** \`${formatDuration(item.song.durationSeconds)}\`` +
            `${item.requesterId ? ` · <@${item.requesterId}>` : ""}`
        );
    });

    const header = current
        ? `**Now:** ${safe(current.song.title, 120)} \`${formatDuration(elapsedSeconds)} / ${formatDuration(
              current.song.durationSeconds
          )}\`\n\n`
        : "";

    return base({
        color: COLORS.playback,
        author: "Queue",
        title: items.length ? `${items.length} shown` : "Queue is empty",
        description: `${header}${lines.join("\n") || "Nothing queued. Add something with `play`."}`,
        footer: `Page ${page} of ${Math.max(1, pageCount)} · total ${formatDuration(totalDurationSeconds)}`,
    });
}

// --- Radio -----------------------------------------------------------------

export function radioEmbed({ station, elapsedMs, degraded = false, reason = "" }) {
    if (degraded || !station) {
        return base({
            color: COLORS.error,
            author: "999 FM",
            title: "Station may be offline",
            description:
                reason ||
                "The station status is stale or reporting that it is not live. Audio may continue, " +
                    "but the track information below cannot be trusted.",
            footer: "999 FM · JuiceWRLDAPI.com",
        });
    }

    const now = station.nowPlaying;
    const elapsed = Math.max(0, Number(elapsedMs) || 0) / 1000;
    const total = Number(station.nowPlaying?.durationMs) > 0 ? station.nowPlaying.durationMs / 1000 : null;
    const bar = progressBar(elapsed, total);

    const preview = station.queuePreview.slice(0, 5);
    return base({
        color: COLORS.radio,
        author: `${safe(station.station, 100)} · live`,
        title: safe(now?.display || now?.title || "Unknown track", LIMITS.title),
        description:
            `\`${formatDuration(elapsed)}\` ${bar} \`${formatDuration(total)}\`` +
            (now?.album ? `\n${safe(now.album, 200)}` : ""),
        fields: [
            { name: "Up next", value: now ? safe(station.upNext?.display ?? "Unknown", 300) : "", inline: false },
            {
                name: "Queue preview",
                value: preview.length ? preview.map((line, i) => `\`${i + 1}.\` ${safe(line, 150)}`).join("\n") : "",
                inline: false,
            },
            { name: "Listeners", value: String(station.totalListeners ?? 0), inline: true },
            { name: "DJ", value: station.djLine ? safe(station.djLine, 200) : "", inline: true },
        ],
        footer: "999 FM · live stream, not seekable · JuiceWRLDAPI.com",
    });
}
