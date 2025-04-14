import type { FeedData } from "./feed-data-type.ts";

export type Scanner = {
  scan: (currentUrl: URL, document: Document) => FeedData[];
};
