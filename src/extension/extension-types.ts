import type { FeedData } from "../lib/scanners/feed-data-type.ts";

export type Message = ListFeedsMessage | VisibilityLostMessage;

type ListFeedsMessage = {
  action: "list-feeds";
  feedsData: FeedData[];
};

type VisibilityLostMessage = {
  action: "visibility-lost";
};
