import type { FeedData } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

const channelNameRegexp = /@(.+?):/u;
export class OdseeScanner implements Scanner {
  scan(currentUrl: URL, _document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("odysee.com")) {
      return [];
    }

    const channelNameMatch = channelNameRegexp.exec(currentUrl.href);
    if (!channelNameMatch) {
      return [];
    }

    const channelName = channelNameMatch[1];
    const href = `https://lbryfeed.melroy.org/channel/${channelName}`;
    return [{ title: "Channel feed", url: href }];
  }
}
