import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

export class HiveblogScanner implements Scanner {
  scan(currentUrl: URL, _document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("hive.blog")) {
      return [];
    }
    const channelNameMatch = /hive\.blog\/(.+)/.exec(currentUrl.href);
    if (!channelNameMatch) {
      return [];
    }
    const channelName = channelNameMatch[1];
    const href = "https://www.hiverss.com/" + channelName + "/feed";
    return [{ url: href, title: "Channel feed" }];
  }
}
