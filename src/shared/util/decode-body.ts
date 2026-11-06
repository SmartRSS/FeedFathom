// Picks a body's encoding: a BOM wins, then the Content-Type charset, then the
// label `declaration` captures in the first `sniffBytes` bytes, then UTF-8.
// The in-document declaration (XML prolog, HTML <meta>) is ASCII-compatible,
// so decoding the prefix as windows-1252 (a superset of ASCII with no invalid
// byte sequences) is always safe just to go looking for it.
function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return undefined;
}

// The raw label, unvalidated: whether an unknown one is ignored is the
// caller's policy.
function headerCharset(contentType: string | null): string | undefined {
  const charset = /charset=([^;]+)/i.exec(contentType ?? "")?.[1]?.trim();
  return charset ? charset.replace(/^"(.*)"$/, "$1") : undefined;
}

export function detectEncoding(
  bytes: Uint8Array,
  contentType: string | null,
  declaration: RegExp,
  sniffBytes: number,
): string {
  const transport = bomEncoding(bytes) ?? headerCharset(contentType);
  if (transport) return transport;

  const prefix = new TextDecoder("windows-1252").decode(
    bytes.subarray(0, sniffBytes),
  );
  return declaration.exec(prefix)?.[1] ?? "utf-8";
}

export function decodeBody(
  bytes: Uint8Array,
  contentType: string | null,
  declaration: RegExp,
  sniffBytes: number,
): string {
  try {
    return new TextDecoder(
      detectEncoding(bytes, contentType, declaration, sniffBytes),
    ).decode(bytes);
  } catch {
    // Unrecognized label; UTF-8 is the right default for almost every body.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Matches both <meta charset="x"> and the http-equiv Content-Type form.
const metaCharsetPattern = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/giu;

// The encoding a label names, or undefined for one TextDecoder doesn't know
// (including the "replacement" labels, which it refuses).
const knownEncoding = (label: string | undefined) => {
  if (!label) return undefined;
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
};

// HTML's rules rather than a feed's: a header label the browser doesn't know
// is ignored, and the meta prescan skips comments and unknown labels. A meta
// tag read as ASCII can't truly mean UTF-16, and x-user-defined means
// windows-1252 there, as the HTML spec prescribes. ponytail: a regex over
// the first 1024 bytes, not the full prescan; a "charset=" inside another
// attribute's value still matches.
function detectHtmlEncoding(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const transport =
    bomEncoding(bytes) ?? knownEncoding(headerCharset(contentType));
  if (transport) return transport;
  const prefix = new TextDecoder("windows-1252")
    .decode(bytes.subarray(0, 1024))
    .replace(/<!--[\s\S]*?-->/gu, "");
  for (const [, label] of prefix.matchAll(metaCharsetPattern)) {
    const encoding = knownEncoding(label);
    if (encoding?.startsWith("utf-16")) return "utf-8";
    if (encoding === "x-user-defined") return "windows-1252";
    if (encoding) return encoding;
  }
  return "utf-8";
}

export const decodeHtml = (
  bytes: Uint8Array,
  contentType: string | null,
): string =>
  new TextDecoder(detectHtmlEncoding(bytes, contentType)).decode(bytes);
