import { afterEach, expect, test } from "bun:test";
import {
  neighbours,
  offlineUnread,
  prefetchNext,
  unreadSourceIds,
} from "../reading-prefetch.ts";

afterEach(() => prefetchNext.set(false));

// Both download in the background, so neither may start without consent.
// Persistence is storedToggle's, covered in preferences.test.ts.
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

const source = (uid: string, unreadCount: number) => ({
  favicon: null,
  homeUrl: "",
  kind: "feed" as const,
  name: uid,
  type: "source" as const,
  uid,
  unreadCount,
  xmlUrl: "",
});

test("only sources with unread are asked about, folders included", () => {
  expect(
    unreadSourceIds([
      source("1", 2),
      source("2", 0),
      { children: [source("3", 1)], name: "f", type: "folder", uid: "9" },
    ]),
  ).toEqual([1, 3]);
});
