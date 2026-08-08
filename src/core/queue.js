import { err, ok } from "./result.js";

/**
 * Pure queue reducer. Every operation takes a state and returns a new state —
 * nothing here mutates, does I/O, reads a clock, or generates randomness. The
 * shuffle RNG is injected for exactly that reason.
 *
 * `GuildPlayer` owns an instance of this state and is the only thing allowed to
 * replace it. Commands call player methods; they never touch a queue array.
 *
 * State shape:
 *   { items: QueueItem[], loop: "off" | "track" | "queue" }
 *   QueueItem: { song, requesterId }
 *
 * Positions in the public API are **1-based**, because that is what users type.
 */

export const LOOP_MODES = Object.freeze(["off", "track", "queue"]);

/** Hard ceiling so one guild cannot queue the entire 2,500-song archive into memory. */
export const MAX_QUEUE_LENGTH = 500;

export function createQueue(loop = "off") {
    return Object.freeze({ items: Object.freeze([]), loop });
}

function withItems(state, items, loop = state.loop) {
    return Object.freeze({ items: Object.freeze(items), loop });
}

export function isEmpty(state) {
    return state.items.length === 0;
}

export function size(state) {
    return state.items.length;
}

/** Null for any unknown duration, so a partial queue does not report a confident wrong total. */
export function totalDuration(state, current = null) {
    const all = current ? [current, ...state.items] : state.items;
    let total = 0;
    for (const item of all) {
        const seconds = item?.song?.durationSeconds;
        if (!Number.isFinite(seconds)) continue;
        total += seconds;
    }
    return total;
}

export function enqueue(state, item) {
    if (state.items.length >= MAX_QUEUE_LENGTH) {
        return err(`The queue is full (${MAX_QUEUE_LENGTH} tracks). Remove something first.`);
    }
    return ok(withItems(state, [...state.items, item]));
}

/** Insert at the front — `playnext`. */
export function enqueueNext(state, item) {
    if (state.items.length >= MAX_QUEUE_LENGTH) {
        return err(`The queue is full (${MAX_QUEUE_LENGTH} tracks). Remove something first.`);
    }
    return ok(withItems(state, [item, ...state.items]));
}

/** Takes the head. Returns the item and the remaining state. */
export function dequeue(state) {
    if (isEmpty(state)) return { state, item: null };
    const [head, ...rest] = state.items;
    return { state: withItems(state, rest), item: head };
}

function validPosition(state, position, label) {
    if (!Number.isInteger(position)) return err(`${label} must be a whole number.`);
    if (state.items.length === 0) return err("The queue is empty.");
    if (position < 1 || position > state.items.length) {
        return err(`${label} must be between 1 and ${state.items.length}.`);
    }
    return null;
}

export function remove(state, position) {
    const invalid = validPosition(state, position, "Position");
    if (invalid) return invalid;
    const items = [...state.items];
    const [item] = items.splice(position - 1, 1);
    return ok({ state: withItems(state, items), item });
}

export function move(state, from, to) {
    const invalidFrom = validPosition(state, from, "The position to move from");
    if (invalidFrom) return invalidFrom;
    const invalidTo = validPosition(state, to, "The position to move to");
    if (invalidTo) return invalidTo;
    if (from === to) return ok({ state, item: state.items[from - 1] });

    const items = [...state.items];
    const [item] = items.splice(from - 1, 1);
    items.splice(to - 1, 0, item);
    return ok({ state: withItems(state, items), item });
}

/** Drops everything queued. The current track keeps playing — that is `stop`'s job. */
export function clear(state) {
    return withItems(state, []);
}

/**
 * Fisher-Yates with an injected RNG.
 *
 * @param {object} state
 * @param {() => number} rng returns [0, 1)
 */
export function shuffle(state, rng) {
    if (typeof rng !== "function") throw new TypeError("shuffle requires an RNG function");
    const items = [...state.items];
    for (let index = items.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(rng() * (index + 1));
        [items[index], items[swap]] = [items[swap], items[index]];
    }
    return withItems(state, items);
}

/** Drops everything before `position` and takes that item. */
export function jump(state, position) {
    const invalid = validPosition(state, position, "Position");
    if (invalid) return invalid;
    const items = state.items.slice(position - 1);
    const [item, ...rest] = items;
    return ok({ state: withItems(state, rest), item });
}

export function setLoop(state, mode) {
    if (!LOOP_MODES.includes(mode)) {
        return err(`Loop mode must be one of ${LOOP_MODES.join(", ")}.`);
    }
    return ok(withItems(state, [...state.items], mode));
}

export function cycleLoop(state) {
    const next = LOOP_MODES[(LOOP_MODES.indexOf(state.loop) + 1) % LOOP_MODES.length];
    return withItems(state, [...state.items], next);
}

/**
 * Decides what plays next when the current track ends.
 *
 * @param {object} state
 * @param {object|null} current the item that just finished
 * @param {{ skipping?: boolean }} options `skipping` is a user-issued skip, which
 *        clears a `track` loop for this advance only — otherwise `skip` under
 *        track-loop would replay the same song forever and look broken.
 * @returns {{ state: object, next: object|null }}
 */
export function advance(state, current, { skipping = false } = {}) {
    if (state.loop === "track" && current && !skipping) {
        return { state, next: current };
    }

    if (state.loop === "queue" && current) {
        const items = [...state.items, current];
        const [next, ...rest] = items;
        return { state: withItems(state, rest), next: next ?? null };
    }

    const { state: nextState, item } = dequeue(state);
    return { state: nextState, next: item };
}

/** A page of the queue, 1-based, for the queue embed. */
export function page(state, pageNumber, pageSize = 10) {
    const pageCount = Math.max(1, Math.ceil(state.items.length / pageSize));
    const clamped = Math.min(Math.max(1, Math.trunc(pageNumber) || 1), pageCount);
    const start = (clamped - 1) * pageSize;
    return {
        page: clamped,
        pageCount,
        pageSize,
        items: state.items.slice(start, start + pageSize),
    };
}
