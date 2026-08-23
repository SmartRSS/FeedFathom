import { describe, expect, test } from "bun:test";
import {
  defaultLeaseSeconds,
  leaseExpiresAt,
  resolveLeaseSeconds,
  shouldAttemptWebSubSubscribe,
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

describe("shouldAttemptWebSubSubscribe", () => {
  test("subscribes when nothing has been tried", () => {
    expect(shouldAttemptWebSubSubscribe(undefined)).toBe(true);
    expect(shouldAttemptWebSubSubscribe("none")).toBe(true);
  });

  // Subscribing again is idempotent from the hub's perspective, so retrying a
  // pending subscription self-heals a verification the hub silently dropped.
  test("retries a subscription still awaiting verification", () => {
    expect(shouldAttemptWebSubSubscribe("pending")).toBe(true);
  });

  test("leaves a live subscription alone", () => {
    expect(shouldAttemptWebSubSubscribe("verified")).toBe(false);
  });

  test("does not retry one the hub refused", () => {
    expect(shouldAttemptWebSubSubscribe("failed")).toBe(false);
  });
});
