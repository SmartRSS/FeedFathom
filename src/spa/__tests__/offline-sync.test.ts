import { expect, test } from "bun:test";
import { OfflineSyncPacer } from "../offline-sync.ts";
import { fakeTimers } from "./fake-timers.ts";

function harness() {
  const timers = fakeTimers();
  const state = { ready: true, syncs: 0, wanted: true };
  const pacer = new OfflineSyncPacer({
    ready: () => state.ready,
    sync: () => {
      state.syncs += 1;
    },
    timers,
    wanted: () => state.wanted,
  });
  return { pacer, state, timers };
}

test("syncs at once, then at most once a minute however often asked", () => {
  const { pacer, state, timers } = harness();
  pacer.request();
  timers.advance(0);
  expect(state.syncs).toBe(1);
  pacer.request();
  timers.advance(30_000);
  pacer.request();
  timers.advance(29_999);
  expect(state.syncs).toBe(1);
  timers.advance(1);
  expect(state.syncs).toBe(2);
});

test("a sync that cannot run now waits for the next request", () => {
  const { pacer, state, timers } = harness();
  state.ready = false;
  pacer.request();
  timers.advance(0);
  expect(state.syncs).toBe(0);
  state.ready = true;
  pacer.request();
  timers.advance(0);
  expect(state.syncs).toBe(1);
});

test("an unwanted or disposed sync never runs", () => {
  const { pacer, state, timers } = harness();
  state.wanted = false;
  pacer.request();
  timers.advance(0);
  state.wanted = true;
  pacer.request();
  pacer.dispose();
  timers.advance(60_000);
  expect(state.syncs).toBe(0);
});
