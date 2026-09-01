// The wire contract between the Cloudflare email worker and /api/mail. Both
// ends enforce the same size ceiling and read the same header, so they live
// here rather than as a matched pair of literals free to drift apart.
export const mailRelaySecretHeader = "x-feedfathom-mail-secret";
export const maxRawEmailBytes = 5 * 1_024 * 1_024;
// The MIME message travels base64-encoded rather than as text: a raw email is
// bytes, and 8-bit bodies in a legacy charset do not survive a decode/encode
// round trip through UTF-8 -- every byte outside a valid sequence comes back
// as U+FFFD. Base64 inflates by 4/3, so the JSON string ceiling is that much
// looser than the ceiling on the bytes it carries.
export const maxRelayPayloadChars = Math.ceil(maxRawEmailBytes / 3) * 4;
// btoa output only: standard alphabet, padded, no line breaks.
export const base64Pattern = "^[A-Za-z0-9+/]+={0,2}$";
