// Picks a body's encoding: a BOM wins, then the Content-Type charset, then the
// label `declaration` captures in the first `sniffBytes` bytes, then UTF-8.
// The in-document declaration (XML prolog, HTML <meta>) is ASCII-compatible,
// so decoding the prefix as windows-1252 (a superset of ASCII with no invalid
// byte sequences) is always safe just to go looking for it.
export function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return undefined;
}

// The raw label, unvalidated: whether an unknown one is ignored is the
// caller's policy.
export function headerCharset(contentType: string | null): string | undefined {
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
