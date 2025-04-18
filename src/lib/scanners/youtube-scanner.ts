import type { FeedData } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

const playlistExpression = /list=([\w-]+)/u;
const channelExpression = /channel\/(.+)/u;
const userExpression = /c\/(.+)/u;
export class YoutubeScanner implements Scanner {
  scan(currentUrl: URL, _document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("youtube.com")) {
      return [];
    }

    return this.findFeedsForYoutubeAddress(currentUrl.href);
  }

  private findFeedsForYoutubeAddress(address: string) {
    const youtubeFeeds: FeedData[] = [];
    const addressUrl = new URL(address);
    const userMatch = userExpression.exec(address);
    if (userMatch) {
      youtubeFeeds.push({
        title: "User feed",
        url: `https://www.youtube.com/feeds/videos.xml?user=${userMatch[1]}`,
      });
    }

    const channelMatch = channelExpression.exec(address);
    if (channelMatch) {
      youtubeFeeds.push({
        title: "Channel feed",
        url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch[1]}`,
      });
    }

    const channelMatch2 = new RegExp(`${addressUrl}\\/(@.+)`, "u").exec(
      address,
    );
    if (channelMatch2) {
      youtubeFeeds.push({
        title: "Channel feed",
        url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch2[1]}`,
      });
    }

    const playlistMatch = playlistExpression.exec(address);
    if (playlistMatch) {
      youtubeFeeds.push({
        title: "Current playlist feed",
        url: `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistMatch[1]}`,
      });
    }

    if (youtubeFeeds.length === 0) {
      if (!address.includes("watch")) {
        return youtubeFeeds;
      }

      const channelLink = document.querySelector(
        "#upload-info .ytd-channel-name>a",
      );
      if (!channelLink) {
        return youtubeFeeds;
      }

      const href = channelLink.getAttribute("href");
      if (!href) {
        return youtubeFeeds;
      }

      youtubeFeeds.push(...this.findFeedsForYoutubeAddress(href));
    }

    return youtubeFeeds;
  }
}
