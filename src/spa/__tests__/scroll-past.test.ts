import { describe, expect, test } from "bun:test";
import { ScrollPastQueue } from "../scroll-past.ts";

// A manual clock: nothing here sleeps, the tests step time forward and fire
// the one scheduled callback exactly like the real timer would.
function fakeClock() {
  let time = 0;
  let callback: (() => void) | undefined;
  let deadline: number | undefined;
  const now = () => time;
  const schedule = (cb: () => void, ms: number) => {
    callback = cb;
    deadline = time + ms;
    return cb;
  };
  const cancelScheduled = () => {
    callback = undefined;
  };
  return {
    advance(ms: number) {
      time += ms;
      // A real timer stays silent until its deadline; so does this one.
      if (callback === undefined || deadline === undefined || time < deadline)
        return;
      const cb = callback;
      callback = undefined;
      cb();
    },
    cancelScheduled,
    now,
    pending: () => callback !== undefined,
    schedule,
  };
}

function makeQueue(
  clock: ReturnType<typeof fakeClock>,
  batches: number[][],
  options: { cap?: number; flushEveryMs?: number } = {},
) {
  return new ScrollPastQueue({
    cancelScheduled: clock.cancelScheduled,
    ...(options.cap === undefined ? {} : { cap: options.cap }),
    ...(options.flushEveryMs === undefined
      ? {}
      : { flushEveryMs: options.flushEveryMs }),
    flush: (ids) => batches.push(ids),
    now: clock.now,
    schedule: clock.schedule,
  });
}

describe("ScrollPastQueue", () => {
  test("a row that dwells past the timeout is flushed", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches);
    queue.add(7);
    expect(batches).toEqual([]);
    clock.advance(999);
    expect(batches).toEqual([]);
    clock.advance(1);
    expect(batches).toEqual([[7]]);
  });

  test("a row that leaves before the dwell completes is never flushed", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches);
    queue.add(7);
    clock.advance(500);
    queue.cancel(7);
    clock.advance(2000);
    expect(batches).toEqual([]);
  });

  test("re-entering the viewport restarts the dwell", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches);
    queue.add(7);
    clock.advance(600);
    queue.cancel(7);
    queue.add(7);
    clock.advance(600);
    expect(batches).toEqual([]);
    clock.advance(400);
    expect(batches).toEqual([[7]]);
  });

  test("adding the same row twice does not restart its dwell", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches);
    queue.add(7);
    clock.advance(600);
    queue.add(7);
    clock.advance(400);
    expect(batches).toEqual([[7]]);
  });

  test("several dwelled rows leave in one batch", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches);
    queue.add(1);
    clock.advance(250);
    queue.add(2);
    queue.add(3);
    clock.advance(1000);
    expect(batches).toEqual([[1, 2, 3]]);
  });

  test("flushes are spaced at least flushEveryMs apart", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches);
    queue.add(1);
    clock.advance(1000);
    expect(batches).toEqual([[1]]);
    queue.add(2);
    clock.advance(999);
    expect(batches).toEqual([[1]]);
    clock.advance(1);
    expect(batches).toEqual([[1], [2]]);
  });

  test("reaching the cap flushes without waiting for the throttle", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches, { cap: 3 });
    for (const id of [1, 2, 3]) queue.add(id);
    clock.advance(1000);
    expect(batches).toEqual([[1, 2, 3]]);
  });

  test("flushNow sends the pending batch immediately", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    // A long throttle, so the finished dwell cannot ride a scheduled flush.
    const queue = makeQueue(clock, batches, { flushEveryMs: 5000 });
    queue.add(5);
    clock.advance(1000);
    // The first batch goes out as soon as its dwell completes; the throttle
    // dates from before it.
    expect(batches).toEqual([[5]]);
    queue.add(6);
    clock.advance(1000);
    // Dwelled but held back by the throttle.
    expect(batches).toEqual([[5]]);
    queue.flushNow();
    expect(batches).toEqual([[5], [6]]);
  });

  test("flushNow with nothing pending makes no call", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches);
    queue.flushNow();
    expect(batches).toEqual([]);
  });

  test("dispose drops pending rows without flushing", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches);
    queue.add(1);
    clock.advance(1000);
    queue.add(2);
    queue.dispose();
    clock.advance(5000);
    expect(batches).toEqual([[1]]);
    expect(clock.pending()).toBe(false);
  });

  test("cancel of an unknown id is a no-op", () => {
    const clock = fakeClock();
    const batches: number[][] = [];
    const queue = makeQueue(clock, batches);
    queue.add(1);
    queue.cancel(99);
    clock.advance(1000);
    expect(batches).toEqual([[1]]);
  });
});
