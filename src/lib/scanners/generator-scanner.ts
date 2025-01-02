import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

export class GeneratorScanner implements Scanner {
  async scan(currentUrl: URL, document: Document): Promise<FeedData[]> {
    const generator = document.querySelector('meta[name="generator"]');
    if (!generator) {
      return [];
    }

    if (generator.getAttribute("content")?.includes("WordPress")) {
      return [{ url: `${currentUrl.origin}/feed`, title: `Wordpress Feed` }];
    }
    return [];
  }
}
