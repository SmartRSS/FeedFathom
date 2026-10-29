import { afterEach, expect, test } from "bun:test";
import {
  neighbours,
  offlineUnread,
  prefetchNext,
  unreadSourceIds,
} from "../reading-prefetch.ts";

afterEach(() => prefetchNext.set(false));

test("the preference defaults to off and follows the last set value", () => {
  expect(prefetchNext.get()).toBe(false);
  prefetchNext.set(true);
  expect(prefetchNext.get()).toBe(true);
  prefetchNext.set(false);
  expect(prefetchNext.get()).toBe(false);
});

test("neighbours returns the next then the previous article", () => {
  const items = ["a", "b", "c"];
  expect(neighbours(items, 1)).toEqual(["c", "a"]);
  expect(neighbours(items, 0)).toEqual(["b"]);
  expect(neighbours(items, 2)).toEqual(["b"]);
  expect(neighbours(["a"], 0)).toEqual([]);
  expect(neighbours(items, undefined)).toEqual([]);
});

test("offline reading defaults to off", () => {
  expect(offlineUnread.get()).toBe(false);
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
