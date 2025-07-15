import { logError as error } from "../../util/log.ts";
import type { FeedData, FeedSourceType } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

const selector = [
  'link[type="application/rss+xml"]',
  'link[type="application/atom+xml"]',
  'link[type="application/json"]',
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
    const feedType = feed.getAttribute("type");
    let type: FeedSourceType;

    if (feedType === "application/atom+xml") {
      type = "atom";
    } else if (feedType === "application/rss+xml") {
      type = "rss";
    } else if (feedType === "application/json") {
      type = "jsonfeed";
    } else {
      type = "unknown-xml";
    }

    yield { title, url: resolvedUrl, type };
  }
};

export class HeadScanner implements Scanner {
  scan(_currentUrl: URL, document: Document): FeedData[] {
    const feeds: FeedData[] = [];

    if (!document.baseURI) {
      error("Document does not have a valid baseURI.");
      return [];
    }

    feeds.push(...Array.from(getFeeds(document)));

    // WebSub detection
    const hubLink = document.querySelector(
      'link[rel="hub"]',
    ) as HTMLLinkElement | null;
    const selfLink = document.querySelector(
      'link[rel="self"]',
    ) as HTMLLinkElement | null;

    if (hubLink && selfLink) {
      feeds.push({
        title: selfLink.title || document.title || "WebSub Feed",
        url: selfLink.href,
        type: "websub",
        webSub: {
          hub: hubLink.href,
          self: selfLink.href,
        },
      });
    }

    return feeds;
  }
}
