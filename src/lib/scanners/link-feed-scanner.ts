import type { FeedData } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

const feedUrlPatterns = [
  /\/(rss|feed|atom|feeds)\/?$/iu,
  /\.(rss|xml|atom)$/iu,
  /feeds?\/(rss|atom)/iu,
  /\/syndication\/?$/iu,
] as const;
export class LinkFeedScanner implements Scanner {
  scan(currentUrl: URL, document: Document): FeedData[] {
    const feeds: FeedData[] = [];

    // Search for anchor elements
    const anchorElements = document.querySelectorAll("a");

    for (const anchor of anchorElements) {
      const href = anchor.getAttribute("href");
      if (!href) {
        continue;
      }

      try {
        const feedUrl = new URL(href, currentUrl.href);

        // Skip if it's not the same domain
        if (feedUrl.hostname !== currentUrl.hostname) {
          continue;
        }

        // Check if URL matches common feed patterns
        if (this.isFeedUrl(feedUrl.pathname)) {
          feeds.push({
            title: anchor.textContent?.trim() ?? "Untitled Feed",
            url: feedUrl.href,
          });
        }
      } catch {}
    }

    return feeds;
  }

  private isFeedUrl(pathname: string): boolean {
    return feedUrlPatterns.some((pattern) => {
      return pattern.test(pathname);
    });
  }
}
