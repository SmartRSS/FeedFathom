import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { hostIs } from "#shared/scanners/host.ts";

const playlistExpression = /list=([\w-]+)/u;
const channelExpression = /channel\/(.+)/u;
const userExpression = /c\/(.+)/u;
const findYoutubeFeeds = (address: string, page: ScannerPage): FeedData[] => {
  const youtubeFeeds: FeedData[] = [];
  const userMatch = userExpression.exec(address);
  if (userMatch)
    youtubeFeeds.push({
      title: "User feed",
      url: `https://www.youtube.com/feeds/videos.xml?user=${userMatch[1]}`,
    });

  const channelMatch = channelExpression.exec(address);
  if (channelMatch)
    youtubeFeeds.push({
      title: "Channel feed",
      url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch[1]}`,
    });

  const playlistMatch = playlistExpression.exec(address);
  if (playlistMatch)
    youtubeFeeds.push({
      title: "Current playlist feed",
      url: `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistMatch[1]}`,
    });

  if (youtubeFeeds.length || !address.includes("watch")) return youtubeFeeds;
  return page.youtubeChannelHref
    ? findYoutubeFeeds(page.youtubeChannelHref, page)
    : youtubeFeeds;
};

export const scanYoutube = (currentUrl: URL, page: ScannerPage): FeedData[] =>
  hostIs(currentUrl, "youtube.com")
    ? findYoutubeFeeds(currentUrl.href, page)
    : [];
