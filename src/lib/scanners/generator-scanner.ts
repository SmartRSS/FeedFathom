import type { FeedData } from "./feed-data-type.ts";
import type { Scanner } from "./scanner-interface.ts";

export class GeneratorScanner implements Scanner {
  scan(currentUrl: URL, document: Document): FeedData[] {
    const generator = document.querySelector('meta[name="generator"]');
    if (!generator) {
      return [];
    }

    if (generator.getAttribute("content")?.includes("WordPress")) {
      return [{ title: "Wordpress Feed", url: `${currentUrl.origin}/feed` }];
    }

    return [];
  }
}
