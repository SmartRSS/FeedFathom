import { describe, expect, test } from "bun:test";
import { isLoopbackAddress } from "#shared/net/private-network-guard.ts";

describe("isLoopbackAddress", () => {
  test.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "accepts loopback address %s",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  test.each(["", "127.0.0.2", "192.0.2.1", "::ffff:192.0.2.1"])(
    "rejects non-loopback address %s",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false);
    },
  );
});
