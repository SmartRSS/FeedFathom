import { describe, expect, test } from "bun:test";
import { formatBadgeCount } from "../badge.ts";

describe("formatBadgeCount", () => {
  test.each([
    [0, ""],
    [1, "1"],
    [3, "3"],
    [99, "99"],
    [100, "99+"],
    [1234, "99+"],
  ])("formats %i as %s", (count, expected) => {
    expect(formatBadgeCount(count)).toBe(expected);
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "treats %p as no feeds",
    (count) => {
      expect(formatBadgeCount(count)).toBe("");
    },
  );
});
