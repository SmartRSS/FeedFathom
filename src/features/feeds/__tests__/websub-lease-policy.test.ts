import { expect, test } from "bun:test";
import {
  defaultLeaseSeconds,
  resolveLeaseSeconds,
  shouldAttemptWebSubSubscribe,
} from "../websub-lease-policy.ts";

test("honours a finite positive lease from the hub", () => {
  expect(resolveLeaseSeconds("3600")).toBe(3600);
});

// Everything here arrives straight off the wire from a third-party hub.
test.each([
  ["no lease", undefined],
  ["a non-numeric lease", "soon"],
  // Number("") is 0, which is finite -- so this only survives because the
  // positivity check runs too.
  ["an empty lease", ""],
  ["a lease that would already have expired", "0"],
  ["a negative lease", "-60"],
  ["a lease that would never expire", "Infinity"],
])("falls back on %s", (_case, lease) => {
  expect(resolveLeaseSeconds(lease)).toBe(defaultLeaseSeconds);
});

// Subscribing again is idempotent from the hub's perspective, so retrying a
// pending subscription self-heals a verification the hub silently dropped.
// A live subscription is left alone, and one the hub refused is not retried.
test.each([
  [undefined, true],
  ["none", true],
  ["pending", true],
  ["verified", false],
  ["failed", false],
] as const)("subscribes from status %p: %p", (status, attempt) => {
  expect(shouldAttemptWebSubSubscribe(status)).toBe(attempt);
});
