import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

export class SteemitScanner implements Scanner {
  scan(currentUrl: URL, _document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("steemit.com")) {
      return [];
    }

    const channelNameMatch = /steemit\.com\/(.+)/.exec(currentUrl.href);
    if (!channelNameMatch) {
      return [];
    }
    const channelName = channelNameMatch[1];
    return [
      {
        url: `https://www.hiverss.com/${channelName}/feed`,
        title: "Channel feed",
      },
    ];
  }
}
