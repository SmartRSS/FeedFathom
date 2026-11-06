// The wire contract between the Cloudflare email worker and /api/mail. Plain
// TypeScript rather than schemas: the worker is bundled for Cloudflare, and
// typebox's runtime would dominate its cold start. The server's
// incomingMailRequest schema is checked against MailRelayRequest where the
// route reads it.
export const mailRelayPath = "/api/mail";
export const mailRelaySecretHeader = "x-feedfathom-mail-secret";

export type MailRelayRequest = {
  from: string;
  // The MIME message, base64-encoded rather than as text: a raw email is
  // bytes, and 8-bit bodies in a legacy charset do not survive a
  // decode/encode round trip through UTF-8 -- every byte outside a valid
  // sequence comes back as U+FFFD.
  raw: string;
  to: string;
};

// A message that is the sender's fault. The worker bounces only on this;
// anything else, a schema 422 from version skew included, is retried.
export const mailRelayRejectionStatus = 422;
export type MailRelayRejection = { error: string; rejected: true };

export const maxRawEmailMebibytes = 5;
export const maxRawEmailBytes = maxRawEmailMebibytes * 1_024 * 1_024;
// Base64 inflates by 4/3, so the JSON string ceiling is that much looser than
// the ceiling on the bytes it carries.
export const maxRelayPayloadChars = Math.ceil(maxRawEmailBytes / 3) * 4;
// btoa output only: standard alphabet, padded, no line breaks.
export const base64Pattern = "^[A-Za-z0-9+/]+={0,2}$";
