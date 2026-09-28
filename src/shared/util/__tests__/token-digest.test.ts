import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { digestToken } from "#shared/util/token-digest.ts";

test("digests as unsalted hex SHA-256, so stored digests stay lookable", () => {
  const token = "0123abcd-4567-89ef-abcd-0123456789ab";
  expect(digestToken(token)).toBe(
    createHash("sha256").update(token).digest("hex"),
  );
});

test("digests differ per token and are stable across calls", () => {
  expect(digestToken("one")).not.toBe(digestToken("two"));
  expect(digestToken("one")).toBe(digestToken("one"));
});

test("digests are lowercase hex, as the database column stores them", () => {
  expect(digestToken("anything")).toMatch(/^[0-9a-f]{64}$/);
});
