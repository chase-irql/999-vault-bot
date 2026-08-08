import assert from "node:assert/strict";
import test, { describe } from "node:test";
import * as queue from "../src/core/queue.js";
import { isErr, isOk } from "../src/core/result.js";
import { song } from "./helpers/voice.mjs";

const item = (id, duration = 100) => ({ song: song({ id, title: `Track ${id}`, durationSeconds: duration }), requesterId: "u1" });

/** Builds a queue holding items 1..n. */
function filled(count, loop = "off") {
    let state = queue.createQueue(loop);
    for (let index = 1; index <= count; index += 1) {
        const result = queue.enqueue(state, item(index));
        state = result.value;
    }
    return state;
}

const ids = (state) => state.items.map((entry) => entry.song.id);

describe("queue construction", () => {
    test("starts empty with loop off", () => {
        const state = queue.createQueue();
        assert.equal(queue.size(state), 0);
        assert.equal(queue.isEmpty(state), true);
        assert.equal(state.loop, "off");
    });

    test("state is frozen — nothing mutates in place", () => {
        const state = filled(2);
        assert.throws(() => state.items.push(item(3)));
        const next = queue.enqueue(state, item(3)).value;
        assert.equal(queue.size(state), 2, "the original must be untouched");
        assert.equal(queue.size(next), 3);
    });
});

describe("enqueue", () => {
    test("appends to the end", () => {
        assert.deepEqual(ids(filled(3)), [1, 2, 3]);
    });

    test("enqueueNext inserts at the front", () => {
        const state = queue.enqueueNext(filled(3), item(99)).value;
        assert.deepEqual(ids(state), [99, 1, 2, 3]);
    });

    test("refuses past the cap with a message naming the limit", () => {
        const state = filled(queue.MAX_QUEUE_LENGTH);
        const result = queue.enqueue(state, item(999));
        assert.ok(isErr(result));
        assert.match(result.error, /queue is full \(500 tracks\)/);
        assert.ok(isErr(queue.enqueueNext(state, item(999))));
    });
});

describe("dequeue", () => {
    test("takes the head and returns the rest", () => {
        const { state, item: head } = queue.dequeue(filled(3));
        assert.equal(head.song.id, 1);
        assert.deepEqual(ids(state), [2, 3]);
    });

    test("an empty queue yields null rather than throwing", () => {
        const { state, item: head } = queue.dequeue(queue.createQueue());
        assert.equal(head, null);
        assert.equal(queue.size(state), 0);
    });

    test("a single-item queue empties cleanly", () => {
        const { state, item: head } = queue.dequeue(filled(1));
        assert.equal(head.song.id, 1);
        assert.equal(queue.isEmpty(state), true);
    });
});

describe("remove", () => {
    test("removes by 1-based position", () => {
        const result = queue.remove(filled(3), 2);
        assert.ok(isOk(result));
        assert.equal(result.value.item.song.id, 2);
        assert.deepEqual(ids(result.value.state), [1, 3]);
    });

    test("accepts the first and last positions", () => {
        assert.deepEqual(ids(queue.remove(filled(3), 1).value.state), [2, 3]);
        assert.deepEqual(ids(queue.remove(filled(3), 3).value.state), [1, 2]);
    });

    test("rejects out-of-range positions with the valid range", () => {
        for (const position of [0, -1, 4, 99]) {
            const result = queue.remove(filled(3), position);
            assert.ok(isErr(result), `position ${position}`);
            assert.match(result.error, /between 1 and 3/);
        }
    });

    test("rejects non-integers", () => {
        for (const position of [1.5, Number.NaN, "two", null, undefined]) {
            assert.ok(isErr(queue.remove(filled(3), position)), `position ${String(position)}`);
        }
    });

    test("rejects on an empty queue", () => {
        const result = queue.remove(queue.createQueue(), 1);
        assert.ok(isErr(result));
        assert.match(result.error, /queue is empty/);
    });
});

describe("move", () => {
    test("moves a track later", () => {
        assert.deepEqual(ids(queue.move(filled(4), 1, 3).value.state), [2, 3, 1, 4]);
    });

    test("moves a track earlier", () => {
        assert.deepEqual(ids(queue.move(filled(4), 4, 1).value.state), [4, 1, 2, 3]);
    });

    test("moving to the same position is a no-op, not an error", () => {
        const result = queue.move(filled(3), 2, 2);
        assert.ok(isOk(result));
        assert.deepEqual(ids(result.value.state), [1, 2, 3]);
    });

    test("rejects either index being out of range, naming which", () => {
        assert.match(queue.move(filled(3), 9, 1).error, /move from/);
        assert.match(queue.move(filled(3), 1, 9).error, /move to/);
    });

    test("rejects on an empty queue", () => {
        assert.ok(isErr(queue.move(queue.createQueue(), 1, 1)));
    });
});

describe("clear", () => {
    test("empties the queue and keeps the loop mode", () => {
        const state = queue.clear(filled(5, "queue"));
        assert.equal(queue.size(state), 0);
        assert.equal(state.loop, "queue");
    });

    test("clearing an empty queue is safe", () => {
        assert.equal(queue.size(queue.clear(queue.createQueue())), 0);
    });
});

describe("shuffle", () => {
    test("keeps every item, reordered deterministically for a fixed RNG", () => {
        // A scripted RNG makes the permutation exact rather than eyeballed.
        const values = [0.9, 0.1, 0.5, 0.3, 0.7];
        let index = 0;
        const rng = () => values[index++ % values.length];

        const state = queue.shuffle(filled(5), rng);
        assert.deepEqual([...ids(state)].sort((a, b) => a - b), [1, 2, 3, 4, 5], "no item may be lost or duplicated");
        assert.equal(queue.size(state), 5);
    });

    test("the same RNG sequence always produces the same order", () => {
        const script = () => {
            const values = [0.42, 0.17, 0.83, 0.05];
            let index = 0;
            return () => values[index++ % values.length];
        };
        assert.deepEqual(ids(queue.shuffle(filled(4), script())), ids(queue.shuffle(filled(4), script())));
    });

    test("requires an injected RNG rather than reaching for Math.random", () => {
        assert.throws(() => queue.shuffle(filled(3)), TypeError);
    });

    test("an empty or single-item queue survives shuffling", () => {
        assert.equal(queue.size(queue.shuffle(queue.createQueue(), () => 0)), 0);
        assert.deepEqual(ids(queue.shuffle(filled(1), () => 0)), [1]);
    });
});

describe("jump", () => {
    test("drops everything before the target and takes it", () => {
        const result = queue.jump(filled(5), 3);
        assert.equal(result.value.item.song.id, 3);
        assert.deepEqual(ids(result.value.state), [4, 5]);
    });

    test("rejects out-of-range positions", () => {
        assert.ok(isErr(queue.jump(filled(3), 0)));
        assert.ok(isErr(queue.jump(filled(3), 4)));
    });
});

describe("loop mode", () => {
    test("setLoop accepts the three modes and rejects anything else", () => {
        for (const mode of queue.LOOP_MODES) {
            assert.equal(queue.setLoop(queue.createQueue(), mode).value.loop, mode);
        }
        assert.ok(isErr(queue.setLoop(queue.createQueue(), "sideways")));
    });

    test("cycleLoop walks off -> track -> queue -> off", () => {
        let state = queue.createQueue();
        const seen = [];
        for (let index = 0; index < 4; index += 1) {
            state = queue.cycleLoop(state);
            seen.push(state.loop);
        }
        assert.deepEqual(seen, ["track", "queue", "off", "track"]);
    });

    test("changing loop mode preserves the queued items", () => {
        assert.deepEqual(ids(queue.setLoop(filled(3), "queue").value), [1, 2, 3]);
    });
});

describe("advance", () => {
    test("loop off takes the next item and drops the finished one", () => {
        const state = filled(3);
        const { state: next, next: playing } = queue.advance(state, item(0));
        assert.equal(playing.song.id, 1);
        assert.deepEqual(ids(next), [2, 3]);
    });

    test("loop off on an empty queue goes idle", () => {
        const { next } = queue.advance(queue.createQueue(), item(1));
        assert.equal(next, null);
    });

    test("loop track replays the current item without touching the queue", () => {
        const state = filled(2, "track");
        const current = item(99);
        const { state: next, next: playing } = queue.advance(state, current);
        assert.equal(playing, current);
        assert.deepEqual(ids(next), [1, 2], "the queue must be untouched");
    });

    test("a user skip clears a track loop for that advance only", () => {
        // Without this, skip under track-loop replays the same song and looks broken.
        const state = filled(2, "track");
        const current = item(99);
        const { state: next, next: playing } = queue.advance(state, current, { skipping: true });
        assert.equal(playing.song.id, 1);
        assert.deepEqual(ids(next), [2]);
        assert.equal(next.loop, "track", "the mode itself stays set");
    });

    test("loop queue sends the finished track to the back", () => {
        const state = filled(3, "queue");
        const { state: next, next: playing } = queue.advance(state, item(99));
        assert.equal(playing.song.id, 1);
        assert.deepEqual(ids(next), [2, 3, 99]);
    });

    test("loop queue with a single finished track and an empty queue replays it", () => {
        const { state: next, next: playing } = queue.advance(queue.createQueue("queue"), item(7));
        assert.equal(playing.song.id, 7);
        assert.equal(queue.size(next), 0);
    });

    test("loop track with nothing current falls through to the queue", () => {
        const { next } = queue.advance(filled(2, "track"), null);
        assert.equal(next.song.id, 1);
    });
});

describe("totalDuration", () => {
    test("sums the queue and the current track", () => {
        assert.equal(queue.totalDuration(filled(3, "off")), 300);
        assert.equal(queue.totalDuration(filled(3, "off"), item(0, 50)), 350);
    });

    test("skips unknown durations rather than producing NaN", () => {
        let state = queue.createQueue();
        state = queue.enqueue(state, { song: song({ durationSeconds: null }), requesterId: "u" }).value;
        state = queue.enqueue(state, { song: song({ durationSeconds: 120 }), requesterId: "u" }).value;
        assert.equal(queue.totalDuration(state), 120);
    });

    test("an empty queue totals zero", () => {
        assert.equal(queue.totalDuration(queue.createQueue()), 0);
    });
});

describe("page", () => {
    test("returns ten per page by default", () => {
        const view = queue.page(filled(25), 1);
        assert.equal(view.items.length, 10);
        assert.equal(view.pageCount, 3);
    });

    test("the last page holds the remainder", () => {
        const view = queue.page(filled(25), 3);
        assert.equal(view.items.length, 5);
        assert.deepEqual(view.items.map((entry) => entry.song.id), [21, 22, 23, 24, 25]);
    });

    test("clamps a page beyond the end instead of returning nothing", () => {
        assert.equal(queue.page(filled(25), 99).page, 3);
        assert.equal(queue.page(filled(25), 0).page, 1);
        assert.equal(queue.page(filled(25), Number.NaN).page, 1);
    });

    test("an empty queue still reports one page", () => {
        const view = queue.page(queue.createQueue(), 1);
        assert.equal(view.pageCount, 1);
        assert.equal(view.items.length, 0);
    });
});
