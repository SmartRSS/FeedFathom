const utf8Decoder = new TextDecoder("utf-8");
const windows1252Decoder = new TextDecoder("windows-1252");

const decoderFor = (encoding: string): TextDecoder => {
  const lower = encoding.toLowerCase();
  if (lower === "utf-8" || lower === "utf8") return utf8Decoder;
  if (lower === "windows-1252") return windows1252Decoder;
  return new TextDecoder(encoding);
};

function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return undefined;
}

function headerCharset(contentType: string | null): string | undefined {
  const charset = /charset=([^;]+)/i.exec(contentType ?? "")?.[1]?.trim();
  return charset ? charset.replace(/^"(.*)"$/, "$1") : undefined;
}

const xmlEncodingPattern = /<\?xml[^>]*\bencoding=["']([^"']+)["']/i;

export function decodeXml(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const encoding =
    bomEncoding(bytes) ??
    headerCharset(contentType) ??
    xmlEncodingPattern.exec(
      windows1252Decoder.decode(bytes.subarray(0, 200)),
    )?.[1] ??
    "utf-8";
  try {
    return decoderFor(encoding).decode(bytes);
  } catch {
    return utf8Decoder.decode(bytes);
  }
}

const metaCharsetPattern = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/giu;

const knownEncoding = (label: string | undefined) => {
  if (!label) return undefined;
  try {
    return decoderFor(label).encoding;
  } catch {
    return undefined;
  }
};

function detectHtmlEncoding(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const transport =
    bomEncoding(bytes) ?? knownEncoding(headerCharset(contentType));
  if (transport) return transport;
  const prefix = windows1252Decoder
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
): string => decoderFor(detectHtmlEncoding(bytes, contentType)).decode(bytes);
