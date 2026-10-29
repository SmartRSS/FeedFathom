import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

const channelNameFromUrlExpression = /vimeo\.com\/(.+)/u;
const channelNameTestExpression = /^[A-Za-z]+$/u;
export const scanVimeo = (currentUrl: URL, page: ScannerPage): FeedData[] => {
  if (!currentUrl.hostname.endsWith("vimeo.com")) return [];

  const channelNameFromUrl = channelNameFromUrlExpression.exec(
    currentUrl.href,
  )?.[1];
  const channelName = channelNameTestExpression.test(channelNameFromUrl ?? "")
    ? channelNameFromUrl
    : page.vimeoChannelHref?.replace("/", "");
  if (!channelName) return [];

  return [
    {
      title: "Channel feed",
      url: `https://vimeo.com/${channelName}/videos/rss/`,
    },
  ];
};
