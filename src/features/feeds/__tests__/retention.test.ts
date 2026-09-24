import { expect, test } from "bun:test";
import {
  goneFromFeedBufferFloorHours,
  lastSeenBumpThrottleHours,
} from "#features/feeds/retention.ts";

// An article still in the feed can trail last_success by up to the throttle,
// so a throttle at or past the buffer's floor lets the gone-from-feed rule
// delete it (#897).
test("the last-seen throttle stays under the gone-from-feed buffer floor", () => {
  expect(goneFromFeedBufferFloorHours).toBe(24);
  expect(lastSeenBumpThrottleHours).toBeLessThan(goneFromFeedBufferFloorHours);
});
