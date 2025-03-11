import type { FeedData } from "../../types.ts";

export type Scanner = {
  scan: (currentUrl: URL, document: Document) => FeedData[];
};
