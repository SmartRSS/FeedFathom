import type { ScannerPage } from "../scanner-page.ts";
import type { FeedData } from "./feed-data-type.ts";

const feedBase = "https://www.bitchute.com/feeds/rss/channel/";

export const scanBitchute = (
  currentPage: URL,
  page: ScannerPage,
): FeedData[] => {
  const hostname = currentPage.hostname.toLowerCase();
  if (hostname !== "www.bitchute.com" && hostname !== "bitchute.com") return [];
  if (page.bitchuteChannelName === undefined) return [];

  return [
    {
      title: `Channel feed for ${page.bitchuteChannelName}`,
      url: `${feedBase}${page.bitchuteChannelName}`,
    },
  ];
};
