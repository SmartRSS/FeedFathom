import { type FeedData } from "../../types";
import { type Scanner } from "./scanner.interface";

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
        title: "Channel feed",
        url: `https://www.hiverss.com/${channelName}/feed`,
      },
    ];
  }
}
