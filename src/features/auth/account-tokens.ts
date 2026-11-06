import { createHash, randomUUID } from "node:crypto";

// How long a mailed link stays valid. `words` is what the mail promises.
export const activationLifetime = { ms: 24 * 60 * 60 * 1_000, words: "a day" };
export const resetLifetime = { ms: 60 * 60 * 1_000, words: "an hour" };

export function issueToken(lifetime: { ms: number }) {
  return {
    expiresAt: new Date(Date.now() + lifetime.ms),
    token: randomUUID(),
  };
}

// Only the reset token's digest is stored, so what arrives in a link has to
// be reduced the same way to look it up. SHA-256 unsalted and unstretched:
// the token is 122 random bits from randomUUID, so there is no dictionary to
// defend against.
export const digestToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
