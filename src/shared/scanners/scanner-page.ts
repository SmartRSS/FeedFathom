export type ScannerPage = {
  anchors: { href: string; text: string }[];
  baseUrl: string;
  bitchuteChannelName?: string | undefined;
  feedLinks: { href: string; title?: string | undefined }[];
  generator?: string | undefined;
  hasMicroformatEntries: boolean;
  rootName: string;
  rootXmlns?: string | undefined;
  vimeoChannelHref?: string | undefined;
  youtubeChannelHref?: string | undefined;
};

// The elements a ScannerPage is read from. Both extractors -- the live
// Document here and the server's HTMLRewriter pass -- use this table and take
// the first match of each single-valued selector.
export const scannerSelectors = {
  bitchuteChannel: ".owner>a",
  feedLinks:
    'link[type="application/rss+xml"], link[type="application/atom+xml"], link[type="application/feed+json"]',
  generator: 'meta[name="generator"]',
  microformatEntries: ".h-feed, .h-entry",
  vimeoChannel: "a.js-user-link",
  youtubeChannel: "#upload-info .ytd-channel-name>a",
} as const;

export const scannerPageFromDocument = (
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
