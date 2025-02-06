import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

export class OdseeScanner implements Scanner {
  scan(currentUrl: URL, _document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("odysee.com")) {
      return [];
    }

    const channelNameMatch = /@(.+?):/.exec(currentUrl.href);
    if (!channelNameMatch) {
      return [];
    }
    const channelName = channelNameMatch[1];
    const href = "https://lbryfeed.melroy.org/channel/" + channelName;
    return [{ url: href, title: "Channel feed" }];
  }
}
