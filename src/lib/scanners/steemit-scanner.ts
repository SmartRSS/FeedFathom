import type { ScannerPage } from "../scanner-page.ts";
import type { FeedData } from "./feed-data-type.ts";

const channelNameRegexp = /steemit\.com\/(.+)/u;
export const scanSteemit = (
  currentUrl: URL,
  _page: ScannerPage,
): FeedData[] => {
  if (!currentUrl.hostname.endsWith("steemit.com")) {
    return [];
  }

  const channelNameMatch = channelNameRegexp.exec(currentUrl.href);
  if (!channelNameMatch) {
    return [];
  }

  const channelName = channelNameMatch[1];
  return [
    {
      title: "Channel feed",
      url: `https://www.hiverss.com/${channelName}/feed`,
    },
  ];
};
