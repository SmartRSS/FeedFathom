import type { ScannerPage } from "../scanner-page.ts";
import type { FeedData } from "./feed-data-type.ts";

const channelNameRegexp = /@(.+?):/u;
export const scanOdsee = (currentUrl: URL, _page: ScannerPage): FeedData[] => {
  if (!currentUrl.hostname.endsWith("odysee.com")) {
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
      url: `https://lbryfeed.melroy.org/channel/${channelName}`,
    },
  ];
};
