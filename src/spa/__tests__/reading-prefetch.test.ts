import { expect, test } from "bun:test";
import { offlineUnread, prefetchNext } from "../preferences.ts";
import { neighbours } from "../reading-prefetch.ts";

// Both download in the background, so neither may start without consent.
test("prefetching and offline reading both default to off", () => {
  expect(prefetchNext.get()).toBe(false);
  expect(offlineUnread.get()).toBe(false);
});

test("neighbours returns the next then the previous article", () => {
  const items = ["a", "b", "c"];
  expect(neighbours(items, 1)).toEqual(["c", "a"]);
  expect(neighbours(items, 0)).toEqual(["b"]);
  expect(neighbours(items, 2)).toEqual(["b"]);
  expect(neighbours(["a"], 0)).toEqual([]);
  expect(neighbours(items, undefined)).toEqual([]);
});
