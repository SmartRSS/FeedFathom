import type { FeedData } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

export class BitchuteScanner implements Scanner {
  private readonly feedBase: string =
    "https://www.bitchute.com/feeds/rss/channel/";

  scan(currentPage: URL, document: Document): FeedData[] {
    const hostname = currentPage.hostname.toLowerCase();
    if (hostname !== "www.bitchute.com" && hostname !== "bitchute.com") {
      return [];
    }

    const channelLinkElement = document.querySelector(".owner>a");
    if (!channelLinkElement) {
      return [];
    }

    const channelName = channelLinkElement.textContent;
    const feedLink = `${this.feedBase}${channelName}`;
    return [{ title: `Channel feed for ${channelName}`, url: feedLink }];
  }
}
