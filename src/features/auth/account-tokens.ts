import { createHash, randomUUID } from "node:crypto";

export const activationLifetimeMs = 24 * 60 * 60 * 1_000;

export function issueToken(lifetimeMs: number) {
  return {
    expiresAt: new Date(Date.now() + lifetimeMs),
    token: randomUUID(),
  };
}

export const digestToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
