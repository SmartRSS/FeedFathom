import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

const channelNameFromUrlExpression = /vimeo\.com\/(.+)/u;
const channelNameTestExpression = /^[A-Za-z]+$/u;
export const scanVimeo = (currentUrl: URL, page: ScannerPage): FeedData[] => {
  if (!currentUrl.hostname.endsWith("vimeo.com")) return [];

  const channelNameFromUrl = channelNameFromUrlExpression.exec(
    currentUrl.href,
  )?.[1];
  const channelNameFromLink = page.vimeoChannelHref?.replace("/", "") ?? "";

  return [
    {
      title: "Channel feed",
      url: channelNameTestExpression.test(channelNameFromUrl ?? "")
        ? `https://vimeo.com/${channelNameFromUrl}/videos/rss/`
        : `https://vimeo.com/${channelNameFromLink}/videos/rss/`,
    },
  ];
};
