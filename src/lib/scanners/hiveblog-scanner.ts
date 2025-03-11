import type { FeedData } from "../../types.ts";
import type { Scanner } from "./scanner-interface.ts";

const hiveblogExpression = /hive\.blog\/(.+)/u;
export class HiveblogScanner implements Scanner {
  scan(currentUrl: URL, _document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("hive.blog")) {
      return [];
    }

    const channelNameMatch = hiveblogExpression.exec(currentUrl.href);
    if (!channelNameMatch) {
      return [];
    }

    const channelName = channelNameMatch[1];
    const href = `https://www.hiverss.com/${channelName}/feed`;
    return [{ title: "Channel feed", url: href }];
  }
}
