import { expect, test } from "bun:test";
import {
  resolveLeaseSeconds,
  shouldAttemptWebSubSubscribe,
} from "../websub-lease-policy.ts";

test("honours a finite positive lease from the hub", () => {
  expect(resolveLeaseSeconds("3600")).toBe(3600);
});

test.each([
  ["no lease", undefined],
  ["a non-numeric lease", "soon"],
  ["an empty lease", ""],
  ["a lease that would already have expired", "0"],
  ["a negative lease", "-60"],
  ["a lease that would never expire", "Infinity"],
])("falls back on %s", (_case, lease) => {
  expect(resolveLeaseSeconds(lease)).toBe(86_400);
});

test.each([
  [undefined, true],
  ["none", true],
  ["pending", true],
  ["verified", false],
  ["failed", false],
] as const)("subscribes from status %p: %p", (status, attempt) => {
  expect(shouldAttemptWebSubSubscribe(status)).toBe(attempt);
});
