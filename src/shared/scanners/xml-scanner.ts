import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

export const scanXml = (currentUrl: URL, page: ScannerPage): FeedData[] => {
  const isRss1 =
    (page.rootName === "rdf" || page.rootName === "rdf:rdf") &&
    (page.rootXmlns?.includes("rss") ?? false);

  return ["channel", "feed", "rss"].includes(page.rootName) || isRss1
    ? [{ title: "This feed", url: currentUrl.href }]
    : [];
};
