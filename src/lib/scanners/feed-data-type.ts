export type FeedSourceType =
  | "rss"
  | "atom"
  | "jsonfeed"
  | "websub"
  | "unknown-xml";

export type FeedData = {
  title: string;
  url: string;
  type: FeedSourceType;
  webSub?: { hub: string; self: string } | undefined;
};
