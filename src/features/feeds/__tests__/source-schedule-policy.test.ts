import { describe, expect, test } from "bun:test";
import { clampToPollFloor, pollFloorMs } from "../source-schedule-policy.ts";

describe("clampToPollFloor", () => {
  const now = Date.UTC(2026, 0, 1);

  test("pushes a request in the past out to the floor", () => {
    expect(clampToPollFloor(new Date(now - 86_400_000), now).getTime()).toBe(
      now + pollFloorMs,
    );
  });

  test("a request exactly at the floor is unchanged", () => {
    const requested = new Date(now + pollFloorMs);
    expect(clampToPollFloor(requested, now).getTime()).toBe(
      requested.getTime(),
    );
  });
});
