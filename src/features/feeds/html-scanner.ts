import {
  scannerSelectors,
  type ScannerPage,
} from "#shared/scanners/scanner-page.ts";
import { scanPage } from "#shared/scanners/scanner.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

// The server's counterpart of scannerPageFromDocument: Bun has no DOM, so the
// same ScannerPage is read from raw HTML in one streaming HTMLRewriter pass.
// Like querySelector, each single-valued field keeps its first match.
const scannerPageFromHtml = (address: string, html: string): ScannerPage => {
  const anchors: ScannerPage["anchors"] = [];
  const feedLinks: ScannerPage["feedLinks"] = [];
  let activeAnchor: ScannerPage["anchors"][number] | undefined;
  let baseHref: string | undefined;
  let bitchuteMatches = 0;
  let bitchuteChannelName: string | undefined;
  let generator: string | undefined;
  let hasMicroformatEntries = false;
  let rootName = "";
  let rootXmlns: string | undefined;
  let vimeoChannelHref: string | undefined;
  let youtubeChannelHref: string | undefined;

  new HTMLRewriter()
    .on("*", {
      element(element) {
        if (rootName) return;
        rootName = element.tagName.toLowerCase();
        rootXmlns = element.getAttribute("xmlns") ?? undefined;
      },
    })
    .on("base[href]", {
      element(element) {
        baseHref ??= element.getAttribute("href") ?? undefined;
      },
    })
    .on(scannerSelectors.feedLinks, {
      element(element) {
        feedLinks.push({
          href: element.getAttribute("href") ?? "",
          title: element.getAttribute("title") ?? undefined,
        });
      },
    })
    .on("a", {
      element(element) {
        activeAnchor = {
          href: element.getAttribute("href") ?? "",
          text: "",
        };
        anchors.push(activeAnchor);
      },
      text(text) {
        if (activeAnchor) activeAnchor.text += text.text;
      },
    })
    .on(scannerSelectors.bitchuteChannel, {
      element() {
        bitchuteMatches++;
        bitchuteChannelName ??= "";
      },
      text(text) {
        if (bitchuteMatches === 1) bitchuteChannelName += text.text;
      },
    })
    .on(scannerSelectors.generator, {
      element(element) {
        generator ??= element.getAttribute("content") ?? undefined;
      },
    })
    .on(scannerSelectors.microformatEntries, {
      element() {
        hasMicroformatEntries = true;
      },
    })
    .on(scannerSelectors.vimeoChannel, {
      element(element) {
        vimeoChannelHref ??= element.getAttribute("href") ?? undefined;
      },
    })
    .on(scannerSelectors.youtubeChannel, {
      element(element) {
        youtubeChannelHref ??= element.getAttribute("href") ?? undefined;
      },
    })
    .transform(html);

  return {
    anchors,
    baseUrl: URL.parse(baseHref ?? "", address)?.href ?? address,
    bitchuteChannelName,
    feedLinks,
    generator,
    hasMicroformatEntries,
    rootName,
    rootXmlns,
    vimeoChannelHref,
    youtubeChannelHref,
  };
};

export const scanHtml = (address: string, html: string): FeedData[] =>
  scanPage(address, scannerPageFromHtml(address, html));
