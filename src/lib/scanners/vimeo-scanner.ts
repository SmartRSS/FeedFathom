import type { FeedData } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

const channelNameFromUrlExpression = /vimeo\.com\/(.+)/u;
const channelNameTestExpression = /^[A-Za-z]+$/u;
export class VimeoScanner implements Scanner {
  scan(currentUrl: URL, document: Document): FeedData[] {
    if (!currentUrl.hostname.endsWith("vimeo.com")) {
      return [];
    }

    const channelNameFromUrl = channelNameFromUrlExpression.exec(
      currentUrl.href,
    )?.[1];
    const channelLink = document.querySelector("a.js-user-link");
    const channelNameFromLink =
      channelLink?.getAttribute("href")?.replace("/", "") ?? "";

    if (!channelNameTestExpression.test(channelNameFromUrl ?? "")) {
      return [
        {
          title: "Channel feed",
          url: `https://vimeo.com/${channelNameFromLink}/videos/rss/`,
          type: "rss",
        },
      ];
    }

    return [
      {
        title: "Channel feed",
        url: `https://vimeo.com/${channelNameFromUrl}/videos/rss/`,
        type: "rss",
      },
    ];
  }
}
