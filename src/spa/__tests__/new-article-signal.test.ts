import { describe, expect, test } from "bun:test";
import type { TreeNode } from "#shared/contracts/responses.ts";
import { NewArticleSignal, nextPollDelayMs } from "../new-article-signal.ts";
import { fakeTimers } from "./fake-timers.ts";

const treeWithUnread = (unreadCount: number): TreeNode[] => [
  {
    favicon: null,
    homeUrl: "",
    kind: "feed",
    name: "Feed",
    type: "source",
    uid: "1",
    unreadCount,
    xmlUrl: "",
  },
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(unread: number[] = []) {
  const timers = fakeTimers();
  const state = { hidden: false, loads: 0 };
  const signal = new NewArticleSignal({
    enabled: () => true,
    hidden: () => state.hidden,
    loadTree: async () => {
      state.loads += 1;
      return treeWithUnread(unread.shift() ?? 0);
    },
    onPollFailure: () => {},
    timers,
  });
  return { signal, state, timers };
}

describe("nextPollDelayMs", () => {
  test("starts at 30 seconds and doubles to a 5-minute ceiling", () => {
    expect([0, 1, 2, 3, 4, 10].map((cycle) => nextPollDelayMs(cycle))).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });

  test("an open event stream holds the poll at the ceiling", () => {
    expect(nextPollDelayMs(0, true)).toBe(300_000);
  });
});

describe("NewArticleSignal", () => {
  test("counts a rise over the baseline and keeps the largest", async () => {
    const { signal, timers } = harness([7, 5]);
    signal.start(treeWithUnread(4));
    timers.advance(30_000);
    await settle();
    expect(signal.arrived()).toBe(3);
    timers.advance(60_000);
    await settle();
    expect(signal.arrived()).toBe(3);
  });

  test("a refresh clears the count and moves the baseline", async () => {
    const { signal, timers } = harness([9, 10, 11]);
    signal.start(treeWithUnread(4));
    timers.advance(30_000);
    await settle();
    expect(signal.arrived()).toBe(5);
    await signal.refresh();
    expect(signal.arrived()).toBe(0);
    timers.advance(60_000);
    await settle();
    expect(signal.arrived()).toBe(1);
  });

  test("a hidden tab skips its cycle without loading", async () => {
    const { signal, state, timers } = harness();
    state.hidden = true;
    signal.start(treeWithUnread(0));
    timers.advance(30_000);
    await settle();
    expect(state.loads).toBe(0);
    expect(timers.pendingDelays()).toEqual([30_000]);
  });

  test("stream signals close together share one load", async () => {
    const { signal, state, timers } = harness();
    signal.start(treeWithUnread(0));
    signal.streamSignal();
    timers.advance(1000);
    signal.streamSignal();
    timers.advance(1000);
    await settle();
    expect(state.loads).toBe(1);
  });

  test("a signal during a poll gets one follow-up once it ends", async () => {
    let finish: ((tree: TreeNode[]) => void) | undefined;
    const timers = fakeTimers();
    let loads = 0;
    const signal = new NewArticleSignal({
      enabled: () => true,
      hidden: () => false,
      loadTree: () => {
        loads += 1;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      onPollFailure: () => {},
      timers,
    });
    signal.start(treeWithUnread(0));
    timers.advance(30_000);
    signal.streamSignal();
    signal.streamSignal();
    finish?.(treeWithUnread(0));
    await settle();
    timers.advance(2000);
    expect(loads).toBe(2);
  });

  test("a dropped stream pulls a far poll closer, never pushes it back", () => {
    const { signal, timers } = harness();
    signal.streamOpened();
    signal.start(treeWithUnread(0));
    expect(timers.pendingDelays()).toEqual([300_000]);
    signal.streamFailed();
    expect(timers.pendingDelays()).toEqual([30_000]);
    timers.advance(20_000);
    signal.streamOpened();
    signal.streamFailed();
    expect(timers.pendingDelays()).toEqual([10_000]);
  });

  test("nothing runs after dispose", async () => {
    const { signal, state, timers } = harness();
    signal.start(treeWithUnread(0));
    signal.streamSignal();
    signal.dispose();
    timers.advance(600_000);
    await settle();
    expect(state.loads).toBe(0);
  });
});
