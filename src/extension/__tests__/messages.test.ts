import { expect, test } from "bun:test";
import {
  isListFeedsMessage,
  isVisibilityLostMessage,
  listFeedsMessage,
  visibilityLostMessage,
} from "../messages.ts";

const feed = { title: "Example", url: "https://example.com/feed" };

test("accepts only exact extension message shapes", () => {
  expect(isListFeedsMessage(listFeedsMessage([feed]))).toBe(true);
  expect(isListFeedsMessage({ ...listFeedsMessage([feed]), extra: true })).toBe(
    false,
  );
  expect(
    isListFeedsMessage({
      action: "list-feeds",
      feedsData: [{ ...feed, extra: true }],
    }),
  ).toBe(false);
  expect(isListFeedsMessage({ action: "list-feeds" })).toBe(false);
  expect(
    isListFeedsMessage({
      action: "list-feeds",
      feedsData: [{ url: feed.url }],
    }),
  ).toBe(false);
  expect(isVisibilityLostMessage(visibilityLostMessage)).toBe(true);
  expect(
    isVisibilityLostMessage({ ...visibilityLostMessage, extra: true }),
  ).toBe(false);
});
