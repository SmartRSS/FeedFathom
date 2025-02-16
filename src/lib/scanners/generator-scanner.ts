import { type FeedData } from "../../types";
import { type Scanner } from "./scanner-interface";

export class GeneratorScanner implements Scanner {
  scan(currentUrl: URL, document: Document): FeedData[] {
    const generator = document.querySelector('meta[name="generator"]');
    if (!generator) {
      return [];
    }

    if (generator.getAttribute("content")?.includes("WordPress")) {
      return [{ title: `Wordpress Feed`, url: `${currentUrl.origin}/feed` }];
    }

    return [];
  }
}
