import { type FeedData } from "../../types";

export type Scanner = {
  scan: (currentUrl: URL, document: Document) => FeedData[];
}
