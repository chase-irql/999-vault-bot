import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
    COLORS,
    LIMITS,
    categoryLabel,
    clamp,
    disambiguationEmbed,
    errorEmbed,
    escapeMarkdown,
    formatDuration,
    formatUptime,
    noResultsEmbed,
    nowPlayingEmbed,
    percentOf,
    progressBar,
    queueEmbed,
    queuedEmbed,
    radioEmbed,
    searchEmbed,
    songEmbed,
    statsEmbed,
} from "../src/bot/embeds.js";
import { embedText } from "./helpers/context.mjs";

const song = {
    id: 94034,
    publicId: 2402,
    title: "lucid dreams (forget me)",
    aliases: ["Lucid Dreams", "Remember Me"],
    fileNames: [],
    path: "Compilation/lucid dreams.mp3",
    artist: "Juice WRLD",
    album: "Goodbye & Good Riddance",
    durationSeconds: 239,
    category: "released",
    era: { id: 105, name: "jw 999", timeFrame: "(May 2017-May 2018)", playCount: 9044 },
    imageUrl: "https://juicewrldapi.com/assets/999.jpg",
    streamUrl: "https://juicewrldapi.com/juicewrld/files/download/?path=x.mp3",
    producers: "Dominic Miller & Nick Mira",
    engineers: "Romel Williams",
    recordingLocations: "Chicago, IL",
    leakType: "",
};

/** Recursively checks an embed against every documented Discord limit. */
function assertWithinLimits(embed, label = "embed") {
    if (embed.title !== undefined) assert.ok(embed.title.length <= LIMITS.title, `${label}: title`);
    if (embed.description !== undefined) {
        assert.ok(embed.description.length <= LIMITS.description, `${label}: description`);
    }
    if (embed.author) assert.ok(embed.author.name.length <= LIMITS.authorName, `${label}: author`);
    if (embed.footer) assert.ok(embed.footer.text.length <= LIMITS.footer, `${label}: footer`);
    if (embed.fields) {
        assert.ok(embed.fields.length <= LIMITS.fields, `${label}: field count`);
        for (const field of embed.fields) {
            assert.ok(field.name.length <= LIMITS.fieldName, `${label}: field name "${field.name}"`);
            assert.ok(field.value.length <= LIMITS.fieldValue, `${label}: field value "${field.name}"`);
        }
    }
}

/** The failure modes the brief calls out as "this is unfinished". */
function assertNoJunk(embed, label = "embed") {
    const text = embedText(embed);
    for (const token of ["undefined", "NaN", "null", "[object Object]"]) {
        assert.ok(!text.includes(token), `${label} rendered "${token}": ${text.slice(0, 200)}`);
    }
    assert.ok(embed.color !== undefined, `${label} has no accent colour`);
}

describe("formatDuration", () => {
    test("formats m:ss and h:mm:ss", () => {
        assert.equal(formatDuration(239), "3:59");
        assert.equal(formatDuration(7), "0:07");
        assert.equal(formatDuration(3753), "1:02:33");
        assert.equal(formatDuration(0), "0:00");
    });

    test("renders an unknown duration as --:-- and never NaN:NaN", () => {
        for (const input of [null, undefined, Number.NaN, -1, "abc"]) {
            assert.equal(formatDuration(input), "--:--", `input ${String(input)}`);
        }
    });
});

describe("formatUptime", () => {
    test("scales the unit to the magnitude", () => {
        assert.equal(formatUptime(5_000), "5s");
        assert.equal(formatUptime(65_000), "1m 5s");
        assert.equal(formatUptime(3_700_000), "1h 1m");
        assert.equal(formatUptime(90_000_000), "1d 1h 0m");
    });

    test("never renders a negative or NaN uptime", () => {
        assert.equal(formatUptime(-1), "0s");
        assert.equal(formatUptime(Number.NaN), "0s");
    });
});

describe("progressBar", () => {
    test("is always exactly the requested width", () => {
        for (const [elapsed, total] of [[0, 100], [50, 100], [100, 100], [0, 0]]) {
            assert.equal([...progressBar(elapsed, total)].length, 20, `${elapsed}/${total}`);
        }
    });

    test("moves the marker with progress", () => {
        assert.equal(progressBar(0, 100).indexOf("⬤"), 0);
        assert.ok(progressBar(100, 100).indexOf("⬤") > progressBar(50, 100).indexOf("⬤"));
    });

    test("clamps beyond the end rather than overflowing", () => {
        // A station reporting an elapsed value past its own duration must not
        // draw a bar longer than the bar.
        const bar = progressBar(9_999, 100);
        assert.equal([...bar].length, 20);
        assert.equal(bar.indexOf("⬤"), 19);
    });

    test("handles an unknown total without dividing by zero", () => {
        assert.equal(progressBar(50, null).indexOf("⬤"), 0);
        assert.equal(progressBar(50, 0).indexOf("⬤"), 0);
    });

    test("percentOf stays inside [0, 100]", () => {
        assert.equal(percentOf(50, 100), 50);
        assert.equal(percentOf(9_999, 100), 100);
        assert.equal(percentOf(-50, 100), 0);
        assert.equal(percentOf(50, 0), 0);
        assert.equal(percentOf(50, null), 0);
    });
});

describe("escaping and clamping", () => {
    test("escapes the markdown the archive genuinely contains", () => {
        assert.equal(escapeMarkdown("*bold* _under_ `code`"), "\\*bold\\* \\_under\\_ \\`code\\`");
        assert.equal(escapeMarkdown("a|b~c>d"), "a\\|b\\~c\\>d");
        assert.equal(escapeMarkdown(null), "");
    });

    test("clamps with a visible ellipsis", () => {
        assert.equal(clamp("abcdef", 4), "abc…");
        assert.equal(clamp("abc", 10), "abc");
        assert.equal(clamp(undefined, 10), "");
    });

    test("a title containing markdown cannot break embed formatting", () => {
        const embed = songEmbed({ ...song, title: "*Bad* _Day_ `v1`" });
        assert.ok(embed.title.includes("\\*"), "asterisks must be escaped");
        assertWithinLimits(embed);
    });
});

describe("oversized input", () => {
    const huge = "x".repeat(9_000);
    const oversized = {
        ...song,
        title: huge,
        album: huge,
        artist: huge,
        producers: huge,
        engineers: huge,
        recordingLocations: huge,
        aliases: Array.from({ length: 60 }, () => huge),
        era: { id: 1, name: huge, timeFrame: huge, playCount: 1 },
    };

    test("a deliberately oversized song cannot produce an out-of-limits embed", () => {
        // 4097 characters must never reach Discord and become a 400.
        assertWithinLimits(songEmbed(oversized), "songEmbed");
        assertWithinLimits(nowPlayingEmbed({ song: oversized, elapsedSeconds: 10, requesterId: "1" }), "nowPlaying");
    });

    test("a search result list of oversized entries stays inside limits", () => {
        const many = Array.from({ length: 10 }, () => oversized);
        assertWithinLimits(searchEmbed(many, { query: huge, prefix: "jw!", totalCount: 10 }), "searchEmbed");
        assertWithinLimits(disambiguationEmbed(many.slice(0, 5), { query: huge, prefix: "jw!", timeoutSeconds: 60 }));
    });

    test("an oversized queue page stays inside limits", () => {
        const items = Array.from({ length: 10 }, () => ({ song: oversized, requesterId: "1040000000000000003" }));
        assertWithinLimits(
            queueEmbed({
                current: { song: oversized },
                items,
                page: 1,
                pageCount: 3,
                pageSize: 10,
                totalDurationSeconds: 4_000,
                elapsedSeconds: 10,
            }),
            "queueEmbed"
        );
    });
});

describe("embed content", () => {
    test("now playing shows a bounded progress bar and no junk", () => {
        const embed = nowPlayingEmbed({
            song,
            elapsedSeconds: 100,
            requesterId: "1040000000000000003",
            volume: 80,
            loopMode: "queue",
            queueLength: 3,
        });
        assert.equal(embed.color, COLORS.playback);
        assert.equal(embed.author.name, "Now playing");
        assert.ok(embed.description.includes("⬤"));
        assert.ok(embed.description.includes("3:59"));
        assertNoJunk(embed, "nowPlaying");
        assertWithinLimits(embed);
    });

    test("now playing renders an unknown duration as --:-- rather than NaN", () => {
        const embed = nowPlayingEmbed({ song: { ...song, durationSeconds: null }, elapsedSeconds: 10 });
        assert.ok(embed.description.includes("--:--"));
        assertNoJunk(embed, "nowPlaying/null duration");
    });

    test("a song with no era, album, or producers omits those fields instead of showing undefined", () => {
        const sparse = {
            ...song,
            era: null,
            album: "",
            producers: "",
            engineers: "",
            recordingLocations: "",
            leakType: "",
            aliases: [],
        };
        const embed = songEmbed(sparse);
        assertNoJunk(embed, "songEmbed/sparse");
        const names = embed.fields.map((field) => field.name);
        assert.ok(!names.includes("Producers"), "empty fields are dropped, not rendered blank");
        assert.equal(embed.description, undefined, "no alias line when there are no aliases");
    });

    test("the song embed never carries lyric text", () => {
        // The canonical Song shape has no lyric field; this guards the embed
        // layer against anyone adding one back.
        const embed = songEmbed({ ...song, lyrics: "LYRIC-CANARY", syncedLyrics: "LYRIC-CANARY" });
        assert.ok(!embedText(embed).includes("LYRIC-CANARY"));
    });

    test("a missing thumbnail is omitted rather than set to an empty URL", () => {
        const embed = songEmbed({ ...song, imageUrl: "" });
        assert.equal(embed.thumbnail, undefined);
    });

    test("the requester mention is placed where Discord will render it", () => {
        // Regression: the requester was in the footer, and Discord does not
        // render mentions in footer text — it showed the raw `<@id>` markup.
        const embed = queuedEmbed({ song, position: 2, requesterId: "1040000000000000003" });
        assert.ok(embed.description.includes("<@1040000000000000003>"), "mention must be in the description");
        assert.ok(!embed.footer.text.includes("<@"), "and never in the footer");
    });

    test("a queued embed with no requester still renders cleanly", () => {
        const embed = queuedEmbed({ song, position: 0 });
        assert.ok(!embed.description.includes("Requested by"));
        assertNoJunk(embed, "queuedEmbed/no requester");
    });

    test("search results carry the exact play invocation for each hit", () => {
        const embed = searchEmbed([song], { query: "lucid", prefix: "jw!", totalCount: 7 });
        assert.ok(embed.description.includes("jw!play 94034"));
        assert.ok(embed.footer.text.includes("of 7 matches"));
        assertNoJunk(embed, "searchEmbed");
    });

    test("an empty search result set says so rather than rendering an empty block", () => {
        const embed = searchEmbed([], { query: "zzz", prefix: "jw!", totalCount: 0 });
        assert.equal(embed.description, "Nothing matched.");
        assertNoJunk(embed, "searchEmbed/empty");
    });

    test("the no-results embed names the term and the archive size", () => {
        const embed = noResultsEmbed({ query: "zzz", totalSongs: 2525, prefix: "jw!" });
        assert.equal(embed.color, COLORS.error);
        assert.ok(embed.description.includes("zzz"));
        assert.ok(embed.footer.text.includes("2525"));
        assert.ok(embed.description.includes("jw!search"), "should suggest a next step, not a bare not-found");
    });

    test("the queue embed paginates and totals", () => {
        const items = Array.from({ length: 10 }, (_, index) => ({
            song: { ...song, title: `Track ${index}` },
            requesterId: "1040000000000000003",
        }));
        const embed = queueEmbed({
            current: { song },
            items,
            page: 2,
            pageCount: 3,
            pageSize: 10,
            totalDurationSeconds: 4_000,
            elapsedSeconds: 30,
        });
        assert.equal(embed.footer.text, "Page 2 of 3 · total 1:06:40");
        assert.ok(embed.description.includes("`11.`"), "positions continue across pages");
        assertNoJunk(embed, "queueEmbed");
    });

    test("an empty queue says so", () => {
        const embed = queueEmbed({
            current: null,
            items: [],
            page: 1,
            pageCount: 1,
            pageSize: 10,
            totalDurationSeconds: 0,
        });
        assert.equal(embed.title, "Queue is empty");
        assertNoJunk(embed, "queueEmbed/empty");
    });

    test("error embeds state what failed and what to do, with no stack trace", () => {
        const embed = errorEmbed("Could not join", "I need the Connect permission in General.");
        assert.equal(embed.color, COLORS.error);
        assert.ok(!embedText(embed).includes("at "), "no stack frames");
        assertNoJunk(embed, "errorEmbed");
    });

    test("the stats embed renders category and era breakdowns", () => {
        const embed = statsEmbed({
            stats: {
                totalSongs: 2525,
                categoryStats: { released: 323, unreleased: 1472 },
                eraStats: { "GB&GR": 600, DRFL: 340 },
            },
            uptimeMs: 65_000,
            guildCount: 2,
            activePlayers: 1,
            radioGuilds: 0,
        });
        assert.ok(embedText(embed).includes("2525"));
        assert.ok(embedText(embed).includes("Released: **323**"));
        assertNoJunk(embed, "statsEmbed");
    });

    test("categoryLabel names every real category and degrades gracefully", () => {
        assert.equal(categoryLabel("recording_session"), "Recording session");
        assert.equal(categoryLabel("released"), "Released");
        assert.equal(categoryLabel(undefined), "Unknown");
    });
});

describe("radio embed", () => {
    const station = {
        station: "9 9 9 FM",
        nowPlaying: { title: "Dark Side", display: "Juice WRLD — Dark Side", album: "Outsiders", durationMs: 276_454 },
        upNext: { display: "Juice WRLD — Misery Avenue (v1)" },
        queuePreview: ["a", "b", "c", "d", "e", "f", "g"],
        djLine: "On · every 3-4 songs",
        totalListeners: 14,
    };

    test("renders the live state with a bounded bar and the rose accent", () => {
        const embed = radioEmbed({ station, elapsedMs: 139_148 });
        assert.equal(embed.color, COLORS.radio);
        assert.ok(embed.description.includes("⬤"));
        assertNoJunk(embed, "radioEmbed");
        assertWithinLimits(embed);
    });

    test("shows at most five queue preview entries", () => {
        const embed = radioEmbed({ station, elapsedMs: 0 });
        const preview = embed.fields.find((field) => field.name === "Queue preview");
        assert.equal(preview.value.split("\n").length, 5);
    });

    test("degraded state refuses to show a confidently wrong now-playing", () => {
        const embed = radioEmbed({ station, elapsedMs: 0, degraded: true, reason: "Station is stale." });
        assert.equal(embed.color, COLORS.error);
        assert.equal(embed.title, "Station may be offline");
        assert.ok(!embedText(embed).includes("Dark Side"));
    });

    test("survives a station payload missing up_next and duration", () => {
        const embed = radioEmbed({
            station: { ...station, upNext: null, queuePreview: [], nowPlaying: { display: "x", durationMs: null } },
            elapsedMs: 5_000,
        });
        assertNoJunk(embed, "radioEmbed/sparse");
        assert.ok(embed.description.includes("--:--"), "an endless stream has no total to show");
    });
});
