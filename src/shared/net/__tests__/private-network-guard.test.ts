import { describe, expect, test } from "bun:test";
import {
  isBlockedHostname,
  isLoopbackAddress,
} from "#shared/net/private-network-guard.ts";

describe("isBlockedHostname", () => {
  test.each([
    "localhost",
    "api.localhost",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "[::1]",
    "fd00::1",
    "fe80::1",
    "fe80::1%eth0",
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
  ])("blocks %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  test.each([
    "example.com",
    "feeds.example.com",
    "example.com.",
    "8.8.8.8",
    "1.1.1.1",
    "203.0.113.7",
    "2001:db8::1",
    "::ffff:8.8.8.8",
  ])("allows %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(false);
  });

  // inet_aton takes all of these and reaches 127.0.0.1, but none of them is a
  // dotted quad this guard will decode, and no DNS label is all digits. They
  // are refused on their shape rather than parsed, because matching whatever
  // the transport's resolver does is the part that would be wrong.
  test.each([
    "0177.0.0.1",
    "017.0.0.1",
    "2130706433",
    "0x7f000001",
    "0x7f.1",
    "127.1",
    "127.0.1",
    "1.2.3.4.5",
    "999.1.1.1",
  ])("blocks the non-canonical address %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  // Every other way of spelling a mapped or compressed loopback. The guard
  // does not expand IPv6, so a leading zero group is refused rather than
  // decoded.
  test.each(["0:0:0:0:0:ffff:7f00:1", "::ffff:0:7f00:1", "::127.0.0.1"])(
    "blocks the uncompressed form %s",
    (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(true);
    },
  );
});

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
