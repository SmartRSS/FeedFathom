import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

export class BitchuteScanner implements Scanner {
  private readonly feedBase: string =
    "https://www.bitchute.com/feeds/rss/channel/";

  async scan(currentPage: URL, document: Document): Promise<FeedData[]> {
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
    return [{ url: feedLink, title: `Channel feed for ${channelName}` }];
  }
}
