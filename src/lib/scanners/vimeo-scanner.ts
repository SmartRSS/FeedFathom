import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

export class VimeoScanner implements Scanner {
  scan(currentUrl: URL, document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("vimeo.com")) {
      return [];
    }

    const channelNameFromUrl = /vimeo\.com\/(.+)/.exec(currentUrl.href)?.[1];
    const channelLink = document.querySelector("a.js-user-link");
    const channelNameFromLink =
      channelLink?.getAttribute("href")?.replace("/", "") ?? "";

    if (!/^[a-zA-Z]+$/.test(channelNameFromUrl ?? "")) {
      return [
        {
          url: `https://vimeo.com/${channelNameFromLink}/videos/rss/`,
          title: "Channel feed",
        },
      ];
    }
    return [
      {
        url: `https://vimeo.com/${channelNameFromUrl}/videos/rss/`,
        title: "Channel feed",
      },
    ];
  }
}
