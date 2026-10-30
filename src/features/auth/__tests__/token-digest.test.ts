import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { digestToken } from "#features/auth/token-digest.ts";

test("digests as unsalted hex SHA-256, so stored digests stay lookable", () => {
  const token = "0123abcd-4567-89ef-abcd-0123456789ab";
  expect(digestToken(token)).toBe(
    createHash("sha256").update(token).digest("hex"),
  );
});
