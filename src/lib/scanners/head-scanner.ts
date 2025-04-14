import { logError as error } from "../../util/log.ts";
import type { FeedData } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

const selector = [
  'link[type="application/rss+xml"]',
  'link[type="application/atom+xml"]',
].join(", ");
const getFeeds = function* (document: Document): Generator<FeedData> {
  const baseUrl = document.baseURI || "";

  for (const feed of document.querySelectorAll(selector)) {
    const url = feed.getAttribute("href");
    if (!url) {
      continue;
    }

    const resolvedUrl = new URL(url, baseUrl).toString();
    const title = feed.getAttribute("title") ?? resolvedUrl;

    yield { title, url: resolvedUrl };
  }
};

export class HeadScanner implements Scanner {
  scan(_currentUrl: URL, document: Document): FeedData[] {
    if (!document.baseURI) {
      error("Document does not have a valid baseURI.");
      return [];
    }

    return Array.from(getFeeds(document));
  }
}
