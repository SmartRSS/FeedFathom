import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { hostIs } from "#shared/scanners/host.ts";

const channelNameRegexp = /@(.+?):/u;
export const scanOdsee = (currentUrl: URL, _page: ScannerPage): FeedData[] => {
  if (!hostIs(currentUrl, "odysee.com")) {
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
