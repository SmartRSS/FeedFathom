import { expect, test } from "bun:test";
import {
  serviceWorkerFile,
  serviceWorkerPathPattern,
} from "#shared/contracts/service-worker-file.ts";

// A name the build produces that the pattern misses would be served like
// any file.
test("the worker's served path matches the name the build gives it", () => {
  expect(
    serviceWorkerPathPattern.test(`/${serviceWorkerFile("0123456789ab")}`),
  ).toBe(true);
});
