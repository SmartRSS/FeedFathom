import { type FeedData } from "../../types";
import { type Scanner } from "./scanner-interface";

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
    let isRSS1 = false;
    if (
      (rootName === "rdf" || rootName === "rdf:rdf") &&
      rootDocumentElement.getAttribute("xmlns")
    ) {
      isRSS1 =
        rootDocumentElement.getAttribute("xmlns")?.includes("rss") ?? false;
    }

    if (["channel", "feed", "rss"].includes(rootName) || isRSS1) {
      return [{ title: "This feed", url: currentUrl.href }];
    }

    return [];
  }
}
