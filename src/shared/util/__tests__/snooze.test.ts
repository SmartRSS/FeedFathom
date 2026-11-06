import { describe, expect, test } from "bun:test";
import { isSnoozed } from "#shared/util/snooze.ts";

describe("isSnoozed", () => {
  const now = Date.parse("2026-09-09T12:00:00.000Z");

  test("a future timestamp is snoozed, as a Date or as its wire string", () => {
    expect(isSnoozed(new Date("2026-09-10T12:00:00.000Z"), now)).toBe(true);
    expect(isSnoozed("2026-09-10T12:00:00.000Z", now)).toBe(true);
  });

  test("null, undefined and an unparseable string mean not snoozed", () => {
    expect(isSnoozed(null, now)).toBe(false);
    expect(isSnoozed(undefined, now)).toBe(false);
    expect(isSnoozed("not a date", now)).toBe(false);
  });

  test("a past timestamp has expired back to visible", () => {
    expect(isSnoozed(new Date("2026-09-08T12:00:00.000Z"), now)).toBe(false);
  });

  test("the exact expiry instant is already visible", () => {
    expect(isSnoozed(new Date(now), now)).toBe(false);
  });
});
