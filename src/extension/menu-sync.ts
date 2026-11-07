import type { FeedData } from "#shared/scanners/feed-data-type.ts";

export type MenuOperations = {
  create(properties: chrome.contextMenus.CreateProperties): Promise<void>;
  removeAll(): Promise<void>;
};

export type Schedule = (callback: () => void, delayMs: number) => () => void;

export const timerSchedule: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export const menuDebounceMs = 300;
export const subscribeMenuId = "FeedFathom";
export const newsletterMenuId = "FeedFathom_newsletter";

// Keeps the toolbar icon's context menu in step with the feeds the current
// page reported. The browser builds menus asynchronously, so rebuilds run one
// at a time and each starts from the latest request: a report or a clear
// arriving mid-rebuild is applied by the next pass rather than interleaved
// with this one.
export const createMenuSync = (menus: MenuOperations, schedule: Schedule) => {
  let wanted: FeedData[] | null = null;
  let dirty = false;
  let running = false;
  let cancelPending: (() => void) | undefined;

  const build = async (feeds: FeedData[]) => {
    await Promise.all([
      menus.create({
        contexts: ["action"],
        id: newsletterMenuId,
        title: "newsletter",
      }),
      menus.create({
        contexts: ["action"],
        id: subscribeMenuId,
        title: "Subscribe",
      }),
    ]);
    if (dirty) return;
    // create() rejects on a duplicate id and feed.url is the id, so a page
    // listing the same feed twice would otherwise lose that entry.
    const uniqueFeeds = new Map(feeds.map((feed) => [feed.url, feed]));
    await Promise.all(
      Array.from(uniqueFeeds.values(), (feed) =>
        menus.create({
          contexts: ["action"],
          id: feed.url,
          parentId: subscribeMenuId,
          title: feed.title,
        }),
      ),
    );
  };

  const apply = async () => {
    if (running) return;
    running = true;
    /* eslint-disable no-await-in-loop -- Each pass must finish before the next starts. */
    while (dirty) {
      dirty = false;
      const feeds = wanted;
      try {
        await menus.removeAll();
        if (feeds && !dirty) await build(feeds);
      } catch (error) {
        console.warn("FeedFathom could not rebuild its context menu", error);
      }
    }
    /* eslint-enable no-await-in-loop */
    running = false;
  };

  const request = (feeds: FeedData[] | null) => {
    wanted = feeds;
    dirty = true;
    void apply();
  };

  return {
    clear(): void {
      cancelPending?.();
      cancelPending = undefined;
      request(null);
    },
    show(feeds: FeedData[]): void {
      cancelPending?.();
      cancelPending = schedule(() => {
        cancelPending = undefined;
        request(feeds);
      }, menuDebounceMs);
    },
  };
};
