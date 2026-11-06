import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

const feedUrlPatterns = [
  /\/(rss|feed|atom|feeds)\/?$/iu,
  /\.(rss|xml|atom)$/iu,
  /feeds?\/(rss|atom)/iu,
  /\/syndication\/?$/iu,
] as const;
const isFeedUrl = (pathname: string) =>
  feedUrlPatterns.some((pattern) => pattern.test(pathname));

export const scanLinkFeed = (
  currentUrl: URL,
  page: ScannerPage,
): FeedData[] => {
  const feeds: FeedData[] = [];

  for (const anchor of page.anchors) {
    const feedUrl = anchor.href && URL.parse(anchor.href, currentUrl.href);
    if (!feedUrl || feedUrl.hostname !== currentUrl.hostname) continue;
    if (isFeedUrl(feedUrl.pathname))
      feeds.push({
        title: anchor.text.trim() || "Untitled Feed",
        url: feedUrl.href,
      });
  }

  return feeds;
};
