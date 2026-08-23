import { describe, expect, test } from "bun:test";
import {
  defaultLeaseSeconds,
  leaseExpiresAt,
  resolveLeaseSeconds,
} from "./websub-lease-policy.ts";

describe("resolveLeaseSeconds", () => {
  test("honours a finite positive lease from the hub", () => {
    expect(resolveLeaseSeconds("3600")).toBe(3600);
  });

  // Everything below arrives straight off the wire from a third-party hub.
  test("falls back when the hub names no lease", () => {
    expect(resolveLeaseSeconds(undefined)).toBe(defaultLeaseSeconds);
  });

  test("falls back on a non-numeric lease", () => {
    expect(resolveLeaseSeconds("soon")).toBe(defaultLeaseSeconds);
  });

  // Number("") is 0, which is finite -- so this only survives because the
  // positivity check runs too.
  test("falls back on an empty lease", () => {
    expect(resolveLeaseSeconds("")).toBe(defaultLeaseSeconds);
  });

  test("falls back on a lease that would already have expired", () => {
    expect(resolveLeaseSeconds("0")).toBe(defaultLeaseSeconds);
    expect(resolveLeaseSeconds("-60")).toBe(defaultLeaseSeconds);
  });

  test("falls back on a lease that would never expire", () => {
    expect(resolveLeaseSeconds("Infinity")).toBe(defaultLeaseSeconds);
  });
});

describe("leaseExpiresAt", () => {
  test("converts seconds to an absolute instant", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(leaseExpiresAt(3600, now).getTime()).toBe(now + 3_600_000);
  });
});
