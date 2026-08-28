import { describe, expect, test } from "bun:test";
import { clampToPollFloor, pollFloorMs } from "../source-schedule-policy.ts";

describe("clampToPollFloor", () => {
  const now = Date.UTC(2026, 0, 1);

  test("honours a request further out than the floor", () => {
    const requested = new Date(now + 60 * 60_000);
    expect(clampToPollFloor(requested, now).getTime()).toBe(
      requested.getTime(),
    );
  });

  // An origin sending no-cache/max-age=0 must not be able to make the poller
  // hammer it every gather cycle.
  test("pushes a sooner request out to the floor", () => {
    expect(clampToPollFloor(new Date(now), now).getTime()).toBe(
      now + pollFloorMs,
    );
  });

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
