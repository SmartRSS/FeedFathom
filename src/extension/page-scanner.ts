import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import {
  listFeedsMessage,
  visibilityLostMessage,
  type ListFeedsMessage,
  type VisibilityLostMessage,
} from "./messages.ts";
import type { Schedule } from "./menu-sync.ts";

export const visibilityDebounceMs = 500;
// A single-page app swaps its content after the address changes, so the
// rescan waits for the new page to settle.
export const scanDebounceMs = 1_500;

export type PageScannerEnvironment = {
  hidden(): boolean;
  href(): string;
  scan(href: string): Promise<FeedData[]>;
  schedule: Schedule;
  send(message: ListFeedsMessage | VisibilityLostMessage): void;
};

// Reports the feeds on the current page to the background, rescanning when
// a single-page app changes the address. A scan that finishes after the
// address moved on is dropped: its feeds belong to a page no longer shown.
export const createPageScanner = (environment: PageScannerEnvironment) => {
  let currentHref = environment.href();
  let latestFeeds: FeedData[] = [];
  let scanGeneration = 0;
  let cancelScan: (() => void) | undefined;
  let cancelReport: (() => void) | undefined;

  const report = () => {
    cancelReport?.();
    cancelReport = undefined;
    if (environment.hidden()) {
      environment.send(visibilityLostMessage);
      return;
    }
    cancelReport = environment.schedule(() => {
      cancelReport = undefined;
      environment.send(listFeedsMessage(latestFeeds));
    }, visibilityDebounceMs);
  };

  const scanPage = async (href: string, generation: number) => {
    let feeds: FeedData[];
    try {
      feeds = await environment.scan(href);
    } catch (error) {
      console.warn("FeedFathom could not scan this page for feeds", error);
      return;
    }
    if (generation !== scanGeneration || href !== environment.href()) return;
    latestFeeds = feeds;
    report();
  };

  return {
    report,
    rescanIfHrefChanged(): void {
      const href = environment.href();
      if (href === currentHref) return;
      currentHref = href;
      latestFeeds = [];
      const generation = ++scanGeneration;
      report();
      cancelScan?.();
      cancelScan = environment.schedule(() => {
        cancelScan = undefined;
        void scanPage(href, generation);
      }, scanDebounceMs);
    },
    start(): void {
      currentHref = environment.href();
      void scanPage(currentHref, ++scanGeneration);
    },
  };
};
