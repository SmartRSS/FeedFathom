import type { FeedData } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

export class XmlScanner implements Scanner {
  scan(currentUrl: URL, document: Document): FeedData[] {
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

    if (["channel", "feed", "rss"].includes(rootName) || isRss1) {
      return [{ title: "This feed", url: currentUrl.href }];
    }

    return [];
  }
}
