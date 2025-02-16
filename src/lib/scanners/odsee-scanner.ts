import { type FeedData } from "../../types";
import { type Scanner } from "./scanner-interface";

export class OdseeScanner implements Scanner {
  scan(currentUrl: URL, _document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("odysee.com")) {
      return [];
    }

    const channelNameMatch = /@(.+?):/u.exec(currentUrl.href);
    if (!channelNameMatch) {
      return [];
    }

    const channelName = channelNameMatch[1];
    const href = "https://lbryfeed.melroy.org/channel/" + channelName;
    return [{ title: "Channel feed", url: href }];
  }
}
