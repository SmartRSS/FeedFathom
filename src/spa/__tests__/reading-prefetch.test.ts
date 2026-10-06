import { afterEach, expect, test } from "bun:test";
import {
  navigatorConnection,
  neighbours,
  offlineArticles,
  offlineUnreadEnabled,
  prefetchNextEnabled,
  setPrefetchNext,
  shouldPrefetch,
  unreadSourceIds,
} from "../reading-prefetch.ts";

afterEach(() => setPrefetchNext("off"));

test("the preference defaults to off and follows the last set value", () => {
  expect(prefetchNextEnabled()).toBe("off");
  setPrefetchNext("on");
  expect(prefetchNextEnabled()).toBe("on");
  setPrefetchNext("off");
  expect(prefetchNextEnabled()).toBe("off");
});

test("Save Data suppresses the prefetch; absent connection does not", () => {
  expect(shouldPrefetch({ saveData: true })).toBe(false);
  expect(shouldPrefetch({ saveData: false })).toBe(true);
  expect(shouldPrefetch(undefined)).toBe(true);
});

test("navigatorConnection reads the real connection object when present", () => {
  const withConnection = { connection: { saveData: true } };
  // Partial mock: the function only reads `connection`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  expect(navigatorConnection(withConnection as unknown as Navigator)).toEqual({
    saveData: true,
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  expect(navigatorConnection({} as Navigator)).toBeUndefined();
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
  expect(offlineUnreadEnabled()).toBe("off");
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const row = (id: number, ageDays: number) => ({
  id,
  publishedAt: new Date(NOW - ageDays * DAY).toJSON(),
});

const ids = (rows: { id: number }[]) => rows.map((item) => item.id);

test("offline selection stops at the first row older than 14 days", () => {
  const stale = offlineArticles([row(3, 0), row(2, 13.9), row(1, 14.1)], NOW);
  expect(stale.complete).toBe(true);
  expect(ids(stale.articles)).toEqual([3, 2]);
  const fresh = offlineArticles([row(3, 0)], NOW);
  expect(fresh.complete).toBe(false);
  expect(ids(fresh.articles)).toEqual([3]);
});

test("offline selection keeps at most 500 articles", () => {
  const rows = Array.from({ length: 600 }, (_, index) => row(600 - index, 0));
  const { articles, complete } = offlineArticles(rows, NOW);
  expect(complete).toBe(true);
  expect(articles).toHaveLength(500);
  expect(articles[0]?.id).toBe(600);
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
