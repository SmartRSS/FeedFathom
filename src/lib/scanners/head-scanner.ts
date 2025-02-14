import { type FeedData } from "../../types";
import { logError as error } from "../../util/log";
import { type Scanner } from "./scanner.interface";

const selector = [
  'link[type="application/rss+xml"]',
  'link[type="application/atom+xml"]',
].join(", ");

export class HeadScanner implements Scanner {
  scan(_currentUrl: URL, document: Document): FeedData[] {
    if (!document.baseURI) {
      error("Document does not have a valid baseURI.");
      return [];
    }

    return Array.from(getFeeds(document));
  }
}

function* getFeeds(document: Document): Generator<FeedData> {
  const baseURL = document.baseURI || "";

  for (const feed of document.querySelectorAll(selector)) {
    const url = feed.getAttribute("href");
    if (!url) {
      console.warn("RSS feed link is missing 'href'. Skipping.");
      continue;
    }

    const resolvedURL = new URL(url, baseURL).toString();
    const title = feed.getAttribute("title") || resolvedURL;

    yield { title, url: resolvedURL };
  }
}
