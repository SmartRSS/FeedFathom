import { expect, test } from "bun:test";
import { serviceWorkerFile, serviceWorkerPathPattern } from "../sw-protocol.ts";

// The server gives the worker its own caching headers by this pattern, so a
// name the build produces that it misses would be served like any file.
test("the worker's served path matches the name the build gives it", () => {
  expect(
    serviceWorkerPathPattern.test(`/${serviceWorkerFile("0123456789ab")}`),
  ).toBe(true);
});
