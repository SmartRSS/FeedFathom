import { createHash } from "node:crypto";

// Only the digest is stored, so what arrives in a link has to be reduced the
// same way to look it up. SHA-256 unsalted and unstretched: the token is 122
// random bits from randomUUID, so there is no dictionary to defend against.
export const digestToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
