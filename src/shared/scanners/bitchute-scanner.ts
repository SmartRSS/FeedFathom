import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { hostIs } from "#shared/scanners/host.ts";

const feedBase = "https://www.bitchute.com/feeds/rss/channel/";

export const scanBitchute = (
  currentPage: URL,
  page: ScannerPage,
): FeedData[] => {
  if (!hostIs(currentPage, "bitchute.com")) return [];
  if (page.bitchuteChannelName === undefined) return [];

  return [
    {
      title: `Channel feed for ${page.bitchuteChannelName}`,
      url: `${feedBase}${page.bitchuteChannelName}`,
    },
  ];
};
