import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";
import { err } from "../../util/log";

const selector = [
  'link[type="application/rss+xml"]',
  'link[type="application/atom+xml"]',
].join(", ");

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

    yield { url: resolvedURL, title };
  }
}

export class HeadScanner implements Scanner {
  scan(_currentUrl: URL, document: Document): FeedData[] {
    if (!document.baseURI) {
      err("Document does not have a valid baseURI.");
      return [];
    }
    return Array.from(getFeeds(document));
  }
}
