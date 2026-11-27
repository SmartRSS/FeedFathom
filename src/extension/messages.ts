import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { hasExactKeys } from "#shared/util/exact-object.ts";

export type ListFeedsMessage = {
  action: "list-feeds";
  feedsData: FeedData[];
};
export type VisibilityLostMessage = { action: "visibility-lost" };
type ScanRequestMessage = { action: "scan-request" };

export const listFeedsMessage = (feedsData: FeedData[]): ListFeedsMessage => ({
  action: "list-feeds",
  feedsData,
});

export const visibilityLostMessage: VisibilityLostMessage = {
  action: "visibility-lost",
};

export const scanRequestMessage: ScanRequestMessage = {
  action: "scan-request",
};

const isFeedData = (value: unknown): value is FeedData =>
  hasExactKeys(value, ["title", "url"]) &&
  typeof value.title === "string" &&
  typeof value.url === "string";

export const isFeedDataList = (value: unknown): value is FeedData[] => {
  if (!Array.isArray(value)) {
    return false;
  }
  const items: readonly unknown[] = value;
  return items.every((item) => isFeedData(item));
};

export const isListFeedsMessage = (value: unknown): value is ListFeedsMessage =>
  hasExactKeys(value, ["action", "feedsData"]) &&
  value.action === "list-feeds" &&
  isFeedDataList(value.feedsData);

export const isVisibilityLostMessage = (
  value: unknown,
): value is VisibilityLostMessage =>
  hasExactKeys(value, ["action"]) && value.action === "visibility-lost";

export const isScanRequestMessage = (
  value: unknown,
): value is ScanRequestMessage =>
  hasExactKeys(value, ["action"]) && value.action === "scan-request";
