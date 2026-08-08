import { ApiError } from "../core/errors.js";

/**
 * Archive HTTP client.
 *
 * The timeout / retry / abort semantics are ported from the 999 Vault desktop
 * client (`jw-song-downloader/api-client.js`) rather than reinvented: same
 * retry predicate, same Retry-After handling, same exponential backoff, same
 * deferred cleanup for streamed responses. Behaviour that the desktop app has
 * already proven against this archive is behaviour worth keeping.
 *
 * Added here, because this process is shared by several guilds:
 *   - a global concurrency gate and minimum request spacing, so five guilds
 *     searching at once cannot burst the archive;
 *   - a request counter, so cache tests can assert that a warm query issues
 *     exactly zero HTTP requests.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(signal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    return {
        signal: controller.signal,
        clearTimer() {
            clearTimeout(timer);
        },
        cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        },
        get timedOut() {
            return timedOut;
        },
    };
}

/**
 * Streamed bodies outlive the request, so the timeout must not be cleared until
 * the consumer has finished reading. Wraps the body and defers cleanup to it.
 */
function rawResponseWithCleanup(response, cleanup) {
    if (!response.body) {
        cleanup();
        return response;
    }
    const reader = response.body.getReader();
    let cleaned = false;
    const finish = () => {
        if (cleaned) return;
        cleaned = true;
        cleanup();
    };
    const body = new ReadableStream({
        async pull(controller) {
            try {
                const result = await reader.read();
                if (result.done) {
                    finish();
                    controller.close();
                } else {
                    controller.enqueue(result.value);
                }
            } catch (error) {
                finish();
                controller.error(error);
            }
        },
        async cancel(reason) {
            try {
                await reader.cancel(reason);
            } finally {
                finish();
            }
        },
    });
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

/** Caps in-flight requests and enforces a floor on the gap between starts. */
function createGate({ concurrency, minIntervalMs }) {
    let active = 0;
    let lastStart = 0;
    const waiting = [];

    const release = () => {
        active -= 1;
        const next = waiting.shift();
        if (next) next();
    };

    return {
        async acquire() {
            if (active >= concurrency) {
                await new Promise((resolve) => waiting.push(resolve));
            }
            active += 1;
            const gap = minIntervalMs - (Date.now() - lastStart);
            if (gap > 0) await sleep(gap);
            lastStart = Date.now();
            return release;
        },
        get pending() {
            return waiting.length;
        },
    };
}

export class ArchiveApi {
    constructor({
        baseUrl = "https://juicewrldapi.com/juicewrld",
        timeoutMs = 30_000,
        retries = 4,
        concurrency = 4,
        minIntervalMs = 40,
        // Backoff is 750ms, 1.5s, 3s… in production. Injectable so tests can
        // exercise the real retry policy without sleeping through it.
        backoffBaseMs = 750,
        fetchImpl = globalThis.fetch,
        logger = null,
    } = {}) {
        this.baseUrl = String(baseUrl).replace(/\/$/, "");
        this.timeoutMs = timeoutMs;
        this.retries = retries;
        this.backoffBaseMs = backoffBaseMs;
        this.fetchImpl = fetchImpl;
        this.logger = logger;
        this.requestCount = 0;
        this.gate = createGate({ concurrency, minIntervalMs });
    }

    url(route, query = {}) {
        const url = /^https?:\/\//i.test(route)
            ? new URL(route)
            : new URL(`${this.baseUrl}/${String(route).replace(/^\//, "")}`);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null && value !== "") {
                url.searchParams.set(key, String(value));
            }
        }
        return url;
    }

    async request(route, options = {}) {
        const method = String(options.method ?? "GET").toUpperCase();
        const safeToRetry = options.retry ?? ["GET", "HEAD", "OPTIONS"].includes(method);
        const attempts = safeToRetry ? (options.attempts ?? this.retries) : 1;
        let lastError;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const timed = withTimeout(options.signal, options.timeoutMs ?? this.timeoutMs);
            let cleanupDeferred = false;
            const release = await this.gate.acquire();
            try {
                this.requestCount += 1;
                const headers = {
                    Accept: options.responseType === "raw" ? "*/*" : "application/json",
                    ...options.headers,
                };
                const response = await this.fetchImpl(this.url(route, options.query), {
                    method,
                    headers,
                    signal: timed.signal,
                    redirect: "follow",
                });

                if (!response.ok) {
                    const contentType = response.headers.get("content-type") ?? "";
                    const text = await response.text().catch(() => "");
                    let data = text;
                    if (contentType.includes("json")) {
                        try {
                            data = JSON.parse(text);
                        } catch {
                            // Malformed JSON stays as text.
                        }
                    }
                    throw new ApiError(data?.detail || data?.error || `HTTP ${response.status}`, {
                        status: response.status,
                        statusText: response.statusText,
                        route,
                        retryAfter: Number(response.headers.get("retry-after")) || undefined,
                    });
                }

                if (options.responseType === "raw") {
                    timed.clearTimer();
                    cleanupDeferred = Boolean(response.body);
                    return rawResponseWithCleanup(response, timed.cleanup);
                }
                if (options.responseType === "text") return await response.text();
                if (response.status === 204) return null;

                const contentType = response.headers.get("content-type") ?? "";
                if (contentType.includes("json")) return await response.json();
                return await response.text();
            } catch (error) {
                lastError = error;
                const retryable =
                    safeToRetry &&
                    attempt < attempts &&
                    (timed.timedOut ||
                        error.name === "AbortError" ||
                        error.name === "TimeoutError" ||
                        error.status === 429 ||
                        error.status >= 500 ||
                        error instanceof TypeError);
                if (!retryable || options.signal?.aborted) throw error;

                const serverDelay = Number(error.retryAfter) * 1000;
                const delay =
                    Number.isFinite(serverDelay) && serverDelay > 0
                        ? Math.min(serverDelay, 30_000)
                        : Math.min(this.backoffBaseMs * 2 ** (attempt - 1), 10_000);
                this.logger?.warn("archive request retry", {
                    route,
                    attempt,
                    of: attempts,
                    status: error.status,
                    delayMs: delay,
                });
                await sleep(delay);
            } finally {
                release();
                if (!cleanupDeferred) timed.cleanup();
            }
        }
        throw lastError;
    }

    get(route, query, options = {}) {
        return this.request(route, { ...options, query });
    }

    health() {
        return this.get("/health/", {}, { attempts: 1, timeoutMs: 8_000 });
    }

    /** `/songs/` has no ordering parameter; callers sort client-side. */
    songs(query = {}) {
        return this.get("/songs/", query);
    }

    song(id) {
        return this.get(`/songs/${encodeURIComponent(id)}/`);
    }

    stats() {
        return this.get("/stats/");
    }

    eras(query = {}) {
        return this.get("/eras/", query);
    }

    categories() {
        return this.get("/categories/");
    }

    radioLive() {
        return this.get("/radio/live/", {}, { attempts: 2, timeoutMs: 10_000 });
    }

    /**
     * One random track from the station's library. Preferred over picking a
     * random `/songs/` page because everything here is a real file — a random
     * page is roughly a quarter unplayable records with no `path`.
     */
    radioRandom() {
        return this.get("/radio/random/", {}, { attempts: 2, timeoutMs: 10_000 });
    }

    /** Absolute HTTPS URL for a song's audio. Supports Range; FFmpeg reads it directly. */
    streamUrl(path) {
        return this.url("/files/download/", { path }).toString();
    }

    radioStreamUrl() {
        return this.url("/radio/stream.mp3").toString();
    }

    coverArtUrl(path) {
        return this.url("/files/cover-art/", { path }).toString();
    }

    thumbnailUrl(path, size = 256) {
        return this.url("/files/image-thumbnail/", { path, size }).toString();
    }
}
