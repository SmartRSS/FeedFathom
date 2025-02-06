import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

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
    const userMatch = /c\/(.+)/.exec(address);
    if (userMatch) {
      youtubeFeeds.push({
        url: "https://www.youtube.com/feeds/videos.xml?user=" + userMatch[1],
        title: "User feed",
      });
    }
    const channelMatch = /channel\/(.+)/.exec(address);
    if (channelMatch) {
      youtubeFeeds.push({
        url:
          "https://www.youtube.com/feeds/videos.xml?channel_id=" +
          channelMatch[1],
        title: "Channel feed",
      });
    }
    const channelMatch2 = new RegExp(`${addressUrl}\\/(@.+)`).exec(address);
    if (channelMatch2) {
      youtubeFeeds.push({
        url:
          "https://www.youtube.com/feeds/videos.xml?channel_id=" +
          channelMatch2[1],
        title: "Channel feed",
      });
    }
    const playlistMatch = /list=([a-zA-Z\d\-_]+)/.exec(address);
    if (playlistMatch) {
      youtubeFeeds.push({
        url:
          "https://www.youtube.com/feeds/videos.xml?playlist_id=" +
          playlistMatch[1],
        title: "Current playlist feed",
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
