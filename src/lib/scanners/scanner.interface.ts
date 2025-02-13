import { type FeedData } from "../../types";

export interface Scanner {
  scan: (currentUrl: URL, document: Document) => FeedData[];
}
