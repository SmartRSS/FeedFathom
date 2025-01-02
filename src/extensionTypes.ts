import type { FeedData } from "./types";

type VisibilityLostMessage = {
  action: "visibility-lost";
};

type ListFeedsMessage = {
  action: "list-feeds";
  feedsData: FeedData[];
};

export type Message = VisibilityLostMessage | ListFeedsMessage;
