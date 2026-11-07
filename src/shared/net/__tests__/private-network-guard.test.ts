import { describe, expect, test } from "bun:test";
import {
  isBlockedHostname,
  isLoopbackHostname,
} from "#shared/net/private-network-guard.ts";

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
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "192.88.99.1",
    "224.0.0.1",
    "0.0.0.0",
    "[::]",
    "[::1]",
    "[fc00::1]",
    "[fe80::1]",
    "[ff02::1]",
    "[fec0::1]",
    "[2001:db8::1]",
    "[64:ff9b::a00:1]",
    "[2002::1]",
    "[::ffff:7f00:1]",
    "[::ffff:808:808]",
  ])("blocks non-global address %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  test.each([
    "router",
    "printer.local",
    "nas.lan",
    "box.home.arpa",
    "db.internal",
    "Printer.Local.",
  ])("blocks local hostname %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  test.each([
    "example.com",
    "mirror2.example.com",
    "151.101.1.1",
    "8.8.8.8",
    "8.8.8.8.",
    "[2606:4700::1111]",
  ])("allows public host %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(false);
  });

  // Callers pass URL.hostname, which normalizes these to a dotted quad or a
  // compressed IPv6 address before the table sees them.
  test.each([
    "2130706433",
    "0x7f000001",
    "127.1",
    "0x7f.1",
    "0177.0.0.1",
    "[0:0:0:0:0:0:0:1]",
    "[0:0:0:0:0:0:0:0]",
    "[::ffff:127.0.0.1]",
    "[FE80::1]",
  ])("blocks non-canonical literal %s via URL.hostname", (host) => {
    expect(isBlockedHostname(new URL(`http://${host}/`).hostname)).toBe(true);
  });

  test.each(["017.0.0.1", "134744072"])(
    "allows public non-canonical literal %s via URL.hostname",
    (host) => {
      expect(isBlockedHostname(new URL(`http://${host}/`).hostname)).toBe(
        false,
      );
    },
  );

  test.each(["::1::2", "12345::", "1.2.3"])(
    "blocks malformed IP-ish host %s",
    (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(true);
    },
  );
});

describe("isLoopbackHostname", () => {
  test.each(["localhost", "dev.localhost", "127.0.0.2", "[::1]", "LOCALHOST."])(
    "%s is this machine",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(true);
    },
  );

  test.each(["example.com", "10.0.0.1", "[::2]", "localhost.example.com"])(
    "%s is not",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );
});
