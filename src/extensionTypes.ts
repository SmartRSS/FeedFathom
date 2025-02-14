import { type FeedData } from "./types";

export type Message = ListFeedsMessage | VisibilityLostMessage;

type ListFeedsMessage = {
  action: "list-feeds";
  feedsData: FeedData[];
};

type VisibilityLostMessage = {
  action: "visibility-lost";
};
