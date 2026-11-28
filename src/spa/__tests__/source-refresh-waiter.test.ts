import { describe, expect, test } from "bun:test";
import { SourceRefreshWaiter } from "../source-refresh-waiter.ts";
import { fakeTimers } from "./fake-timers.ts";

describe("SourceRefreshWaiter", () => {
  test("notifying a source settles its waiter immediately and cancels the fallback timer", () => {
    const timers = fakeTimers();
    const waiter = new SourceRefreshWaiter(timers);
    let calls = 0;
    waiter.wait(5, 15_000, () => {
      calls += 1;
    });

    waiter.notify(9);
    expect(calls).toBe(0);

    waiter.notify(5);
    expect(calls).toBe(1);
    expect(timers.pendingDelays()).toEqual([]);

    timers.advance(20_000);
    expect(calls).toBe(1);
  });

  test("falls back to the timer when no event arrives", () => {
    const timers = fakeTimers();
    const waiter = new SourceRefreshWaiter(timers);
    let calls = 0;
    waiter.wait(5, 15_000, () => {
      calls += 1;
    });

    timers.advance(14_999);
    expect(calls).toBe(0);
    timers.advance(1);
    expect(calls).toBe(1);
  });

  test("cancel and dispose prevent callbacks from firing", () => {
    const timers = fakeTimers();
    const waiter = new SourceRefreshWaiter(timers);
    let calls = 0;
    const cancel = waiter.wait(5, 15_000, () => {
      calls += 1;
    });
    cancel();
    waiter.notify(5);
    timers.advance(20_000);
    expect(calls).toBe(0);

    waiter.wait(6, 15_000, () => {
      calls += 1;
    });
    waiter.dispose();
    waiter.notify(6);
    timers.advance(20_000);
    expect(calls).toBe(0);
  });
});
