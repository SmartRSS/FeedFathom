import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  feedDataSchema,
  type FeedData,
} from "#shared/scanners/feed-data-type.ts";

// Runtime messages between the extension's own scripts: the content script
// reports a page's feeds, the background and the popup consume them.
const listFeedsMessageSchema = Type.Object(
  {
    action: Type.Literal("list-feeds"),
    feedsData: Type.Array(feedDataSchema),
  },
  { additionalProperties: false },
);
const visibilityLostMessageSchema = Type.Object(
  { action: Type.Literal("visibility-lost") },
  { additionalProperties: false },
);
const scanRequestMessageSchema = Type.Object(
  { action: Type.Literal("scan-request") },
  { additionalProperties: false },
);

export type ListFeedsMessage = Static<typeof listFeedsMessageSchema>;
export type VisibilityLostMessage = Static<typeof visibilityLostMessageSchema>;
type ScanRequestMessage = Static<typeof scanRequestMessageSchema>;

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

export const isListFeedsMessage = (value: unknown): value is ListFeedsMessage =>
  Value.Check(listFeedsMessageSchema, value);

export const isVisibilityLostMessage = (
  value: unknown,
): value is VisibilityLostMessage =>
  Value.Check(visibilityLostMessageSchema, value);

export const isScanRequestMessage = (
  value: unknown,
): value is ScanRequestMessage => Value.Check(scanRequestMessageSchema, value);
