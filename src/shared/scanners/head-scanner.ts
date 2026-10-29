import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

const getFeeds = function* (page: ScannerPage): Generator<FeedData> {
  for (const feed of page.feedLinks) {
    const resolvedUrl = feed.href && URL.parse(feed.href, page.baseUrl)?.href;
    if (!resolvedUrl) continue;
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
