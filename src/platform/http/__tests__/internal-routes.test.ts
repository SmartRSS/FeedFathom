import { expect, test } from "bun:test";
import { healthcheckResponse } from "#platform/http/internal-routes.ts";

test.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
  "answers a probe from loopback address %s",
  (address) => {
    expect(healthcheckResponse(address, true).status).toBe(200);
  },
);

test.each(["", "127.0.0.2", "192.0.2.1", "::ffff:192.0.2.1"])(
  "refuses a probe from %s",
  (address) => {
    expect(healthcheckResponse(address, true).status).toBe(403);
  },
);

test("reports a process that is not ready yet", () => {
  expect(healthcheckResponse("127.0.0.1", false).status).toBe(503);
});
