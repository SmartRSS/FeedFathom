import type { FeedData } from "../../types.ts";
import type { Scanner } from "./scanner-interface.ts";

const channelNameRegexp = /steemit\.com\/(.+)/u;
export class SteemitScanner implements Scanner {
  scan(currentUrl: URL, _document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("steemit.com")) {
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
        url: `https://www.hiverss.com/${channelName}/feed`,
      },
    ];
  }
}
