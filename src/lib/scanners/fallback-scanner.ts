import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

export class FallbackScanner implements Scanner {
  async scan(currentUrl: URL, _document: Document): Promise<FeedData[]> {
    const potentialFeeds = [
      { url: `${currentUrl.origin}/feed`, title: "/feed" },
      { url: `${currentUrl.origin}/feed/`, title: "/feed/" },
      { url: `${currentUrl.origin}/rss`, title: "/rss" },
      { url: `${currentUrl.origin}/feed/posts/default`, title: "blogspot" },
      {
        url: `${currentUrl.origin}/feed${currentUrl.pathname}`,
        title: "medium",
      },
    ];

    const foundFeeds = await Promise.allSettled(
      potentialFeeds.map(async (potentialFeed) => {
        const r = await fetch(potentialFeed.url);
        if (r.status !== 200) {
          throw new Error("not found");
        }
        return potentialFeed;
      }),
    );

    return foundFeeds
      .filter(
        (ff): ff is PromiseFulfilledResult<FeedData> =>
          ff.status !== "rejected",
      )
      .map((foundFeed) => foundFeed.value);
  }
}
