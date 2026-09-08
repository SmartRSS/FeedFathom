import { describe, expect, test } from "bun:test";
import { storedBadgeEnabled } from "#shared/extension-types.ts";
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

describe("storedBadgeEnabled", () => {
  test("reads the stored value", () => {
    expect(storedBadgeEnabled({ showBadge: true })).toBe(true);
    expect(storedBadgeEnabled({ showBadge: false })).toBe(false);
  });

  test("an unset key means on -- the badge is opt-out", () => {
    expect(storedBadgeEnabled({})).toBe(true);
  });

  test("an unreadable storage result means on, not off", () => {
    for (const value of [
      null,
      "off",
      { showBadge: 0 },
      { extra: true },
      { extra: true, showBadge: false },
    ])
      expect(storedBadgeEnabled(value)).toBe(true);
  });
});
