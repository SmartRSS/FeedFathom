import { bomEncoding, headerCharset } from "#shared/util/decode-body.ts";
import { isBlockedHostname } from "#shared/net/private-network-guard.ts";
import {
  readerBridgeChannel,
  readerBridgeVersion,
  readerErrorResponse,
  type ReaderErrorCode,
  type ReaderRequest,
  type ReaderResponse,
} from "#shared/extension-types.ts";
import { canonicalizeInstance } from "./url-helpers.ts";

const maximumBytes = 5 * 1024 * 1024;
const maximumRedirects = 5;
const timeoutMs = 15_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
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
const htmlEncoding = (bytes: Uint8Array, contentType: string | null) => {
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
};

export type ReaderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ValidatedUrl = { error: ReaderErrorCode } | { url: URL };

const articleTargetUrl = (value: string, baseUrl?: string): URL | undefined => {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

// The sender must be the top frame of the configured instance and carry
// nothing else: an extra key means this isn't the shape we vouched for.
const isReaderSender = (sender: unknown, origin: string): boolean => {
  if (typeof sender !== "object" || sender === null) return false;
  const keys = Object.keys(sender);
  if (keys.length !== 2 || !("frameId" in sender) || !("url" in sender))
    return false;
  const { frameId, url } = sender;
  if (frameId !== 0 || typeof url !== "string") return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

const validateArticleUrl = (value: string, base?: URL): ValidatedUrl => {
  const url = articleTargetUrl(value, base?.href);
  if (!url) return { error: "INVALID_URL" };
  return isBlockedHostname(url.hostname) ? { error: "PRIVATE_URL" } : { url };
};

const authorizeSender = (
  sender: unknown,
  configuredInstance: null | string,
): ReaderErrorCode | undefined => {
  if (!configuredInstance) return "UNAVAILABLE";
  const instance = canonicalizeInstance(configuredInstance);
  if (!instance) return "UNAVAILABLE";

  return isReaderSender(sender, instance) ? undefined : "UNAUTHORIZED";
};

const readBoundedHtml = async (
  response: Response,
): Promise<{ error: ReaderErrorCode } | { html: string }> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes)
    return { error: "TOO_LARGE" };
  if (!response.body) return { html: "" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  /* eslint-disable no-await-in-loop -- Stream chunks and cancellation are ordered. */
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      return { error: "TOO_LARGE" };
    }
    chunks.push(chunk.value);
  }
  /* eslint-enable no-await-in-loop */
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const contentType = response.headers.get("content-type");
  return {
    html: new TextDecoder(htmlEncoding(body, contentType)).decode(body),
  };
};

const fetchArticle = async (
  request: Extract<ReaderRequest, { action: "fetch" }>,
  fetchImplementation: ReaderFetch,
): Promise<ReaderResponse> => {
  let validated = validateArticleUrl(request.url);
  if ("error" in validated)
    return readerErrorResponse(request, validated.error);

  const signal = AbortSignal.timeout(timeoutMs);
  /* eslint-disable no-await-in-loop -- Each fetch follows the previously validated redirect. */
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetchImplementation(validated.url, {
        credentials: "omit",
        redirect: "manual",
        referrer: "",
        signal,
      });

      if (response.type === "opaqueredirect")
        return readerErrorResponse(request, "INVALID_RESPONSE");

      if (redirectStatuses.has(response.status)) {
        if (redirects === maximumRedirects)
          return readerErrorResponse(request, "TOO_MANY_REDIRECTS");
        const location = response.headers.get("location");
        if (!location) return readerErrorResponse(request, "INVALID_RESPONSE");
        validated = validateArticleUrl(location, validated.url);
        if ("error" in validated)
          return readerErrorResponse(request, validated.error);
        continue;
      }

      if (!response.ok) return readerErrorResponse(request, "FETCH_FAILED");
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        contentType !== "text/html" &&
        contentType !== "application/xhtml+xml"
      )
        return readerErrorResponse(request, "NOT_HTML");

      const content = await readBoundedHtml(response);
      if ("error" in content)
        return readerErrorResponse(request, content.error);
      return {
        action: "fetch",
        channel: readerBridgeChannel,
        finalUrl: validated.url.href,
        html: content.html,
        id: request.id,
        ok: true,
        type: "response",
        version: readerBridgeVersion,
      };
    }
  } catch {
    return readerErrorResponse(
      request,
      signal.aborted ? "TIMEOUT" : "FETCH_FAILED",
    );
  }
  /* eslint-enable no-await-in-loop */
};

export const handleReaderRequest = async (
  request: ReaderRequest,
  sender: unknown,
  configuredInstance: null | string,
  fetchImplementation: ReaderFetch = fetch,
): Promise<ReaderResponse> => {
  const authorizationError = authorizeSender(sender, configuredInstance);
  if (authorizationError)
    return readerErrorResponse(request, authorizationError);

  if (request.action === "capabilities")
    return {
      action: "capabilities",
      available: true,
      channel: readerBridgeChannel,
      id: request.id,
      ok: true,
      type: "response",
      version: readerBridgeVersion,
    };

  return fetchArticle(request, fetchImplementation);
};
