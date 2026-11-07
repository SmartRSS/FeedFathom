import {
  scannerSelectors,
  type ScannerPage,
} from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { scanPage } from "#shared/scanners/scanner.ts";

const scannerPageFromDocument = (
  address: string,
  document_: Document,
): ScannerPage => {
  const root =
    document_.querySelector("#webkit-xml-viewer-source-xml")
      ?.firstElementChild ?? document_.documentElement;
  const value = (selector: string, attribute: string) =>
    document_.querySelector(selector)?.getAttribute(attribute) ?? undefined;

  return {
    anchors: Array.from(document_.querySelectorAll("a"), (anchor) => ({
      href: anchor.getAttribute("href") ?? "",
      text: anchor.textContent ?? "",
    })),
    baseUrl: document_.baseURI || address,
    bitchuteChannelName:
      document_.querySelector(scannerSelectors.bitchuteChannel)?.textContent ??
      undefined,
    feedLinks: Array.from(
      document_.querySelectorAll(scannerSelectors.feedLinks),
      (link) => ({
        href: link.getAttribute("href") ?? "",
        title: link.getAttribute("title") ?? undefined,
      }),
    ),
    generator: value(scannerSelectors.generator, "content"),
    hasMicroformatEntries:
      document_.querySelector(scannerSelectors.microformatEntries) !== null,
    rootName: root?.nodeName.toLowerCase() ?? "",
    rootXmlns: root?.getAttribute("xmlns") ?? undefined,
    vimeoChannelHref: value(scannerSelectors.vimeoChannel, "href"),
    youtubeChannelHref: value(scannerSelectors.youtubeChannel, "href"),
  };
};

export const scanDocument = (
  address: string,
  document_: Document,
): FeedData[] => scanPage(address, scannerPageFromDocument(address, document_));
