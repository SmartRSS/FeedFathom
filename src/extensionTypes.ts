import type { FeedData } from "./types.ts";

export type Message = ListFeedsMessage | VisibilityLostMessage;

type ListFeedsMessage = {
  action: "list-feeds";
  feedsData: FeedData[];
};

type VisibilityLostMessage = {
  action: "visibility-lost";
};
