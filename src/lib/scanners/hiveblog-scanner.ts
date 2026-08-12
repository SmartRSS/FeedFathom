import type { ScannerPage } from "../scanner-page.ts";
import type { FeedData } from "./feed-data-type.ts";

const hiveblogExpression = /hive\.blog\/(.+)/u;
export const scanHiveblog = (
  currentUrl: URL,
  _page: ScannerPage,
): FeedData[] => {
  if (!currentUrl.hostname.endsWith("hive.blog")) {
    return [];
  }

  const channelNameMatch = hiveblogExpression.exec(currentUrl.href);
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
