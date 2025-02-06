import { type FeedData } from "../../types";
import { type Scanner } from "./scanner.interface";

export class LinkFeedScanner implements Scanner {
  private readonly feedUrlPatterns = [
    /\/(rss|feed|atom|feeds)\/?$/i,
    /\.(rss|xml|atom)$/i,
    /feeds?\/(rss|atom)/i,
    /\/syndication\/?$/i,
  ];

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
            title: anchor.textContent?.trim() || "Untitled Feed",
            url: feedUrl.href,
          });
        }
      } catch {
        console.warn(`Invalid URL: ${href}`);
      }
    }

    return feeds;
  }

  private isFeedUrl(pathname: string): boolean {
    return this.feedUrlPatterns.some((pattern) => pattern.test(pathname));
  }
}
