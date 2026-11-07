import { describe, expect, test } from "bun:test";
import {
  removalOutcome,
  soleSelectedIndex,
  transitionArticleSelection,
} from "../article-selection.ts";

describe("transitionArticleSelection", () => {
  for (const modifier of ["ctrlKey", "metaKey"] as const) {
    test(`toggles one article with ${modifier}`, () => {
      const added = transitionArticleSelection(new Set([0]), 2, 0, {
        [modifier]: true,
      });
      expect(added).toEqual({ anchor: 2, indexes: new Set([0, 2]) });

      const removed = transitionArticleSelection(
        added.indexes,
        0,
        added.anchor,
        { [modifier]: true },
      );
      expect(removed).toEqual({ anchor: 0, indexes: new Set([2]) });
      expect(soleSelectedIndex(removed.indexes)).toBe(2);
    });
  }

  test("selects the inclusive range from the anchor", () => {
    expect(
      transitionArticleSelection(new Set([0]), 3, 1, { shiftKey: true }),
    ).toEqual({ anchor: 1, indexes: new Set([1, 2, 3]) });

    expect(
      transitionArticleSelection(new Set([0]), 3, 1, {
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toEqual({ anchor: 1, indexes: new Set([0, 1, 2, 3]) });
  });
});

describe("soleSelectedIndex", () => {
  test("chooses only a sole selection and clears for zero or many", () => {
    expect(soleSelectedIndex(new Set([2]))).toBe(2);
    expect(soleSelectedIndex(new Set())).toBeUndefined();
    expect(soleSelectedIndex(new Set([1, 2]))).toBeUndefined();
  });
});

describe("removalOutcome", () => {
  const items = ["a", "b", "c", "d", "e"];

  test("selects the item that took the removed item's place", () => {
    expect(removalOutcome(items, new Set([1]))).toEqual({
      nextIndex: 1,
      remaining: ["a", "c", "d", "e"],
    });
  });

  test("clamps to the last remaining item when the tail is removed", () => {
    expect(removalOutcome(items, new Set([3, 4]))).toEqual({
      nextIndex: 2,
      remaining: ["a", "b", "c"],
    });
  });

  test("returns an out-of-range index when every item is removed", () => {
    expect(removalOutcome(items, new Set([0, 1, 2, 3, 4]))).toEqual({
      nextIndex: -1,
      remaining: [],
    });
  });

  test("uses the lowest removed index when the selection is non-contiguous", () => {
    expect(removalOutcome(items, new Set([3, 0]))).toEqual({
      nextIndex: 0,
      remaining: ["b", "c", "e"],
    });
  });
});
