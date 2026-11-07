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

// The elements a ScannerPage is read from. Both extractors -- the
// extension's over the live Document and the server's HTMLRewriter pass --
// use this table and take the first match of each single-valued selector.
export const scannerSelectors = {
  bitchuteChannel: ".owner>a",
  feedLinks:
    'link[type="application/rss+xml"], link[type="application/atom+xml"], link[type="application/feed+json"]',
  generator: 'meta[name="generator"]',
  microformatEntries: ".h-feed, .h-entry",
  vimeoChannel: "a.js-user-link",
  youtubeChannel: "#upload-info .ytd-channel-name>a",
} as const;
