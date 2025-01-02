import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

export class XmlScanner implements Scanner {
  async scan(currentUrl: URL, document: Document): Promise<FeedData[]> {
    if (typeof document.getRootNode() === "undefined") {
      return [];
    }
    const rootNode = document.getRootNode();
    if (!rootNode) {
      return [];
    }
    let rootDocumentElement = (rootNode as Document).documentElement;
    const d = document.getElementById("webkit-xml-viewer-source-xml");
    if (d && d.firstChild) {
      rootDocumentElement = d.firstChild as HTMLElement;
    }
    const rootName = rootDocumentElement.nodeName.toLowerCase();
    const isRSS1 = false;
    if (rootName === "rdf" || rootName === "rdf:rdf") {
      if (rootDocumentElement.getAttribute("xmlns")) {
        //     isRSS1 = rootDocumentElement.getAttribute('xmlns')?.nodeValue.search('rss') > 0;
      }
    }
    if (["rss", "channel", "feed"].includes(rootName) || isRSS1) {
      return [{ url: currentUrl.href, title: "This feed" }];
    }
    return [];
  }
}
