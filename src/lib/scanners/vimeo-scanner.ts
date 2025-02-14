import { type FeedData } from "../../types";
import { type Scanner } from "./scanner.interface";

export class VimeoScanner implements Scanner {
  scan(currentUrl: URL, document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("vimeo.com")) {
      return [];
    }

    const channelNameFromUrl = /vimeo\.com\/(.+)/.exec(currentUrl.href)?.[1];
    const channelLink = document.querySelector("a.js-user-link");
    const channelNameFromLink =
      channelLink?.getAttribute("href")?.replace("/", "") ?? "";

    if (!/^[A-Za-z]+$/.test(channelNameFromUrl ?? "")) {
      return [
        {
          title: "Channel feed",
          url: `https://vimeo.com/${channelNameFromLink}/videos/rss/`,
        },
      ];
    }

    return [
      {
        title: "Channel feed",
        url: `https://vimeo.com/${channelNameFromUrl}/videos/rss/`,
      },
    ];
  }
}
