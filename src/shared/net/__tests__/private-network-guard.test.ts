import { describe, expect, test } from "bun:test";
import {
  isBlockedHostname,
  isLoopbackAddress,
} from "#shared/net/private-network-guard.ts";

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

describe("isBlockedHostname", () => {
  test.each([
    "localhost",
    "sub.localhost",
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "100.64.0.1",
    "224.0.0.1",
    "0.0.0.0",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "fec0::1",
  ])("blocks private or reserved address %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  test.each([
    "example.com",
    "mirror2.example.com",
    "151.101.1.1",
    "8.8.8.8",
    "2001:db8::1",
    "2606:4700::1111",
    "::ffff:151.101.1.1",
    "::ffff:8.8.4.4",
  ])("allows public host %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(false);
  });

  // Every one of these parses to a private address in a real HTTP client,
  // so the string check must not wave it through as a hostname.
  test.each([
    "2130706433", // integer literal -> 127.0.0.1
    "0x7f000001", // hex integer -> 127.0.0.1
    "127.1", // inet_aton 2-part -> 127.0.0.1
    "0x7f.1", // hex 2-part -> 127.0.0.1
    "0177.0.0.1", // octal -> 127.0.0.1
    "0x7f.0.0.1", // hex dotted quad
    "0177.0.0.1", // octal -> 127.0.0.1
    "0:0:0:0:0:0:0:1", // full-form loopback
    "0:0:0:0:0:0:0:0", // full-form unspecified
    "::ffff:127.0.0.1", // IPv4-mapped loopback, dotted tail
    "::ffff:7f00:1", // IPv4-mapped loopback, hex groups
    "[::1]", // bracketed IPv6
    "fe80::1%eth0", // zone id
    "FE80::1", // uppercase IPv6
  ])("blocks non-canonical literal %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  // IP-ish hosts that do not normalize to any address are blocked rather
  // than treated as hostnames (fail closed).
  test.each([
    "127.08.0.1", // invalid octal: neither octal nor agreed decimal
    "999.1.1.1", // non-final octet out of range
    "4294967296", // 2^32: does not fit an IPv4 literal
    "::1::2", // two "::"
    "12345::", // group too wide
  ])("blocks malformed IP-ish host %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  test.each([
    "017.0.0.1", // octal 15 -> 15.0.0.1, public
    "134744072", // integer -> 8.8.8.8
    "8.8.8.8.", // trailing dot
  ])("normalizes public non-canonical literal %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(false);
  });
});
