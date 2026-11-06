import { decodeHtml } from "#shared/util/decode-body.ts";
import { isBlockedHostname } from "#shared/net/private-network-guard.ts";
import { maximumRedirects, redirectStatuses } from "#shared/net/redirects.ts";
import { httpUrlWithoutCredentials } from "#shared/util/safe-url.ts";
import {
  readerCapabilitiesResponse,
  readerErrorResponse,
  readerFetchResponse,
  readerFetchTimeoutMs,
  readerMaximumHtmlBytes,
  type ReaderErrorCode,
  type ReaderFetchRequest,
  type ReaderRequest,
  type ReaderResponse,
} from "#shared/reader-bridge.ts";
import type { InstanceOrigin } from "./url-helpers.ts";

export type ReaderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ValidatedUrl = { error: ReaderErrorCode } | { url: URL };

// The sender must be the top frame of the configured instance and carry
// nothing else: an extra key means this isn't the shape we vouched for.
const isReaderSender = (sender: unknown, origin: string): boolean => {
  if (typeof sender !== "object" || sender === null) return false;
  const keys = Object.keys(sender);
  if (keys.length !== 2 || !("frameId" in sender) || !("url" in sender))
    return false;
  const { frameId, url } = sender;
  if (frameId !== 0 || typeof url !== "string") return false;
  return URL.parse(url)?.origin === origin;
};

const validateArticleUrl = (value: string, base?: URL): ValidatedUrl => {
  const url = httpUrlWithoutCredentials(value, base?.href);
  if (!url) return { error: "INVALID_URL" };
  return isBlockedHostname(url.hostname) ? { error: "PRIVATE_URL" } : { url };
};

const readBoundedHtml = async (
  response: Response,
): Promise<{ error: ReaderErrorCode } | { html: string }> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > readerMaximumHtmlBytes)
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
    if (bytes > readerMaximumHtmlBytes) {
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
  return { html: decodeHtml(body, response.headers.get("content-type")) };
};

const fetchArticle = async (
  request: ReaderFetchRequest,
  fetchImplementation: ReaderFetch,
): Promise<ReaderResponse> => {
  let validated = validateArticleUrl(request.url);
  if ("error" in validated)
    return readerErrorResponse(request, validated.error);

  const signal = AbortSignal.timeout(readerFetchTimeoutMs);
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
      return readerFetchResponse(request, validated.url.href, content.html);
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
  instance: InstanceOrigin | null,
  fetchImplementation: ReaderFetch = fetch,
): Promise<ReaderResponse> => {
  if (!instance) return readerErrorResponse(request, "UNAVAILABLE");
  if (!isReaderSender(sender, instance))
    return readerErrorResponse(request, "UNAUTHORIZED");
  if (request.action === "capabilities")
    return readerCapabilitiesResponse(request);
  return fetchArticle(request, fetchImplementation);
};
