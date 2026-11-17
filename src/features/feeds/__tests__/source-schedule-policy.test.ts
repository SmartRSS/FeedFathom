import { describe, expect, test } from "bun:test";
import { clampToPollFloor } from "../source-schedule-policy.ts";

describe("clampToPollFloor", () => {
  const now = Date.UTC(2026, 0, 1);

  test("pushes a request in the past out to the floor", () => {
    expect(clampToPollFloor(new Date(now - 86_400_000), now).getTime()).toBe(
      now + 300_000,
    );
  });

  test("a request at or past the floor is unchanged", () => {
    for (const requested of [now + 300_000, now + 3_600_000]) {
      expect(clampToPollFloor(new Date(requested), now).getTime()).toBe(
        requested,
      );
    }
  });
});
