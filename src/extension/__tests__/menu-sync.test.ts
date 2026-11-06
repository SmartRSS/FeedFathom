import { describe, expect, test } from "bun:test";
import {
  createMenuSync,
  menuDebounceMs,
  type MenuOperations,
} from "../menu-sync.ts";
import { fakeSchedule } from "./fake-schedule.ts";

// A menu the browser builds asynchronously: each operation waits until the
// test releases it, and the visible menu is what the operations left.
const browserMenus = () => {
  const items = new Map<string, string | undefined>();
  const waiting: (() => void)[] = [];
  const later = (apply: () => void) =>
    new Promise<void>((resolve, reject) => {
      waiting.push(() => {
        try {
          apply();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  const operations: MenuOperations = {
    create: (properties) =>
      later(() => {
        const id = String(properties.id);
        if (items.has(id)) throw new Error(`duplicate id ${id}`);
        items.set(id, properties.parentId?.toString());
      }),
    removeAll: () => later(() => items.clear()),
  };
  // Releases every operation, including those queued by the ones released.
  const settle = async () => {
    /* eslint-disable no-await-in-loop -- Each release may queue the next pass. */
    while (waiting.length > 0) {
      for (const release of waiting.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    /* eslint-enable no-await-in-loop */
  };
  const feedEntries = () =>
    [...items]
      .filter(([, parent]) => parent === "FeedFathom")
      .map(([id]) => id);
  return { feedEntries, items, operations, settle };
};

const feed = (url: string) => ({ title: url, url });

describe("createMenuSync", () => {
  test("shows the reported feeds under Subscribe after the debounce", async () => {
    const menus = browserMenus();
    const clock = fakeSchedule();
    const sync = createMenuSync(menus.operations, clock.schedule);

    sync.show([feed("https://a.example/feed")]);
    await menus.settle();
    expect(menus.items.size).toBe(0);

    clock.advance(menuDebounceMs);
    await menus.settle();
    expect([...menus.items.keys()].toSorted()).toEqual([
      "FeedFathom",
      "FeedFathom_newsletter",
      "https://a.example/feed",
    ]);
  });

  test("only the last report inside the debounce is built", async () => {
    const menus = browserMenus();
    const clock = fakeSchedule();
    const sync = createMenuSync(menus.operations, clock.schedule);

    sync.show([feed("https://stale.example/feed")]);
    clock.advance(menuDebounceMs - 1);
    sync.show([feed("https://latest.example/feed")]);
    clock.advance(menuDebounceMs);
    await menus.settle();
    expect(menus.feedEntries()).toEqual(["https://latest.example/feed"]);
  });

  test("lists a feed the page names twice once", async () => {
    const menus = browserMenus();
    const clock = fakeSchedule();
    const sync = createMenuSync(menus.operations, clock.schedule);

    sync.show([feed("https://a.example/feed"), feed("https://a.example/feed")]);
    clock.advance(menuDebounceMs);
    await menus.settle();
    expect(menus.feedEntries()).toEqual(["https://a.example/feed"]);
  });

  test("a clear during a rebuild leaves no menu behind", async () => {
    const menus = browserMenus();
    const clock = fakeSchedule();
    const sync = createMenuSync(menus.operations, clock.schedule);

    sync.show([feed("https://a.example/feed")]);
    clock.advance(menuDebounceMs);
    sync.clear();
    await menus.settle();
    expect(menus.items.size).toBe(0);
  });

  test("a clear cancels a report still in its debounce", async () => {
    const menus = browserMenus();
    const clock = fakeSchedule();
    const sync = createMenuSync(menus.operations, clock.schedule);

    sync.show([feed("https://a.example/feed")]);
    sync.clear();
    clock.advance(menuDebounceMs);
    await menus.settle();
    expect(menus.items.size).toBe(0);
  });

  test("a report during a rebuild replaces it once that rebuild ends", async () => {
    const menus = browserMenus();
    const clock = fakeSchedule();
    const sync = createMenuSync(menus.operations, clock.schedule);

    sync.show([feed("https://first.example/feed")]);
    clock.advance(menuDebounceMs);
    sync.show([feed("https://second.example/feed")]);
    clock.advance(menuDebounceMs);
    await menus.settle();
    expect(menus.feedEntries()).toEqual(["https://second.example/feed"]);
  });

  test("a failed rebuild does not stop the next one", async () => {
    const menus = browserMenus();
    const clock = fakeSchedule();
    let failNext = true;
    const sync = createMenuSync(
      {
        create: menus.operations.create,
        removeAll: () => {
          if (!failNext) return menus.operations.removeAll();
          failNext = false;
          return Promise.reject(new Error("browser refused"));
        },
      },
      clock.schedule,
    );
    sync.show([feed("https://first.example/feed")]);
    clock.advance(menuDebounceMs);
    await menus.settle();
    sync.show([feed("https://second.example/feed")]);
    clock.advance(menuDebounceMs);
    await menus.settle();
    expect(menus.feedEntries()).toEqual(["https://second.example/feed"]);
  });
});
