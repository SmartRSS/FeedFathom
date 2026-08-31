// The wire contract between the Cloudflare email worker and /api/mail. Both
// ends enforce the same size ceiling and read the same header, so they live
// here rather than as a matched pair of literals free to drift apart.
export const mailRelaySecretHeader = "x-feedfathom-mail-secret";
export const maxRawEmailBytes = 5 * 1_024 * 1_024;
