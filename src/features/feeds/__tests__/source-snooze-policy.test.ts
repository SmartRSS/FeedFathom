import { describe, expect, test } from "bun:test";
import { isSnoozed } from "../source-snooze-policy.ts";

describe("isSnoozed", () => {
  const now = new Date("2026-09-09T12:00:00.000Z");

  test("a future timestamp is snoozed", () => {
    expect(isSnoozed(new Date("2026-09-10T12:00:00.000Z"), now)).toBe(true);
  });

  test("null and undefined mean not snoozed", () => {
    expect(isSnoozed(null, now)).toBe(false);
    expect(isSnoozed(undefined, now)).toBe(false);
  });

  test("a past timestamp has expired back to visible", () => {
    expect(isSnoozed(new Date("2026-09-08T12:00:00.000Z"), now)).toBe(false);
  });

  test("the exact expiry instant is already visible", () => {
    expect(isSnoozed(new Date(now), now)).toBe(false);
  });
});
