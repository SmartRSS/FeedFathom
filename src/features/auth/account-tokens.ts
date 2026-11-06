import { createHash, randomUUID } from "node:crypto";

export const activationLifetimeMs = 24 * 60 * 60 * 1_000;

export function issueToken(lifetimeMs: number) {
  return {
    expiresAt: new Date(Date.now() + lifetimeMs),
    token: randomUUID(),
  };
}

// Only the reset token's digest is stored, so what arrives in a link has to
// be reduced the same way to look it up. SHA-256 unsalted and unstretched:
// the token is 122 random bits from randomUUID, so there is no dictionary to
// defend against.
export const digestToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
