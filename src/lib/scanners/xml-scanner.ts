import type { FeedData, FeedSourceType } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

export class XmlScanner implements Scanner {
  scan(currentUrl: URL, document: Document): FeedData[] {
    const feeds: FeedData[] = [];

    if (typeof document.getRootNode() === "undefined") {
      return [];
    }

    const rootNode = document.getRootNode();
    let rootDocumentElement = (rootNode as Document).documentElement;
    const d = document.querySelector("#webkit-xml-viewer-source-xml");
    if (d?.firstChild) {
      rootDocumentElement = d.firstChild as HTMLElement;
    }

    const rootName = rootDocumentElement.nodeName.toLowerCase();
    let isRss1 = false;
    if (
      (rootName === "rdf" || rootName === "rdf:rdf") &&
      rootDocumentElement.getAttribute("xmlns")
    ) {
      isRss1 =
        rootDocumentElement.getAttribute("xmlns")?.includes("rss") ?? false;
    }

    let detectedType: FeedSourceType | undefined;
    if (rootName === "rss" || isRss1) {
      detectedType = "rss";
    } else if (rootName === "feed") {
      detectedType = "atom";
    } else if (["channel"].includes(rootName)) {
      detectedType = "rss";
    } else {
      detectedType = "unknown-xml";
    }

    if (["channel", "feed", "rss"].includes(rootName) || isRss1) {
      feeds.push({
        title: "This feed",
        url: currentUrl.href,
        type: detectedType,
      });
    }

    // WebSub detection for XML feeds
    const hubLink = document.querySelector('link[rel="hub"]') as Element | null;
    const selfLink = document.querySelector(
      'link[rel="self"]',
    ) as Element | null;

    if (hubLink && selfLink) {
      feeds.push({
        title:
          selfLink.getAttribute("title") ||
          document.querySelector("title")?.textContent ||
          "WebSub Feed",
        url: selfLink.getAttribute("href") || currentUrl.href,
        type: "websub",
        webSub: {
          hub: hubLink.getAttribute("href") || "",
          self: selfLink.getAttribute("href") || currentUrl.href,
        },
      });
    }

    return feeds;
  }
}
