import type { ScannerPage } from "../scanner-page.ts";
import type { FeedData } from "./feed-data-type.ts";

const getFeeds = function* (page: ScannerPage): Generator<FeedData> {
  for (const feed of page.feedLinks) {
    if (!feed.href) continue;
    const resolvedUrl = new URL(feed.href, page.baseUrl).toString();
    yield { title: feed.title ?? resolvedUrl, url: resolvedUrl };
  }
};

export const scanHead = (_currentUrl: URL, page: ScannerPage): FeedData[] => {
  if (!page.baseUrl) {
    console.error("Document does not have a valid baseURI.");
    return [];
  }

  return Array.from(getFeeds(page));
};
