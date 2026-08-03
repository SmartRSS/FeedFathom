import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  readerBridgeChannel,
  readerBridgeVersion,
  readerErrorResponse,
  type ReaderErrorCode,
  type ReaderRequest,
  type ReaderResponse,
} from "./extension-types.ts";
import { canonicalizeInstance } from "./url-helpers.ts";

const maximumBytes = 5 * 1024 * 1024;
const maximumRedirects = 5;
const timeoutMs = 15_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export type ReaderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type Ipv4Address = [number, number, number, number];
type ValidatedUrl = { error: ReaderErrorCode } | { url: URL };

const ipv4Parts = (hostname: string): Ipv4Address | undefined => {
  const parts = hostname.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)
  )
    return undefined;
  return [
    Number(parts[0]),
    Number(parts[1]),
    Number(parts[2]),
    Number(parts[3]),
  ];
};

const isBlockedIpv4 = ([first, second]: Ipv4Address): boolean =>
  first === 0 ||
  first === 10 ||
  first === 127 ||
  (first === 100 && second >= 64 && second <= 127) ||
  (first === 169 && second === 254) ||
  (first === 172 && second >= 16 && second <= 31) ||
  (first === 192 && second === 168) ||
  (first === 198 && (second === 18 || second === 19)) ||
  first >= 224;

const mappedIpv4Parts = (hostname: string): Ipv4Address | undefined => {
  if (!hostname.startsWith("::ffff:")) return undefined;
  const parts = hostname.slice(7).split(":");
  if (parts.length !== 2 || parts.some((part) => !/^[\da-f]{1,4}$/i.test(part)))
    return undefined;
  const high = Number.parseInt(parts[0]!, 16);
  const low = Number.parseInt(parts[1]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
};

const isBlockedHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;

  const ipv4 = ipv4Parts(normalized);
  if (ipv4) return isBlockedIpv4(ipv4);

  if (!normalized.includes(":")) return false;
  if (normalized === "::" || normalized === "::1") return true;

  const mapped = mappedIpv4Parts(normalized);
  if (mapped) return isBlockedIpv4(mapped);

  const first = Number.parseInt(normalized.split(":", 1)[0]!, 16);
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  );
};

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

const articleTargetSchema = (base?: URL) =>
  Type.Refine(
    Type.String(),
    (value) => articleTargetUrl(value, base?.href) !== undefined,
  );
const publicHostnameSchema = Type.Refine(
  Type.String(),
  (value) => !isBlockedHostname(value),
);
const readerSenderSchema = (origin: string) =>
  Type.Object(
    {
      frameId: Type.Literal(0),
      url: Type.Refine(Type.String(), (value) => {
        try {
          return new URL(value).origin === origin;
        } catch {
          return false;
        }
      }),
    },
    { additionalProperties: false },
  );

const validateArticleUrl = (value: string, base?: URL): ValidatedUrl => {
  if (!Value.Check(articleTargetSchema(base), value))
    return { error: "INVALID_URL" };

  const url = base ? new URL(value, base) : new URL(value);
  return Value.Check(publicHostnameSchema, url.hostname)
    ? { url }
    : { error: "PRIVATE_URL" };
};

const authorizeSender = (
  sender: unknown,
  configuredInstance: null | string,
): ReaderErrorCode | undefined => {
  if (!configuredInstance) return "UNAVAILABLE";
  const instance = canonicalizeInstance(configuredInstance);
  if (!instance) return "UNAVAILABLE";

  return Value.Check(readerSenderSchema(instance), sender)
    ? undefined
    : "UNAUTHORIZED";
};

const readBoundedHtml = async (
  response: Response,
): Promise<{ error: ReaderErrorCode } | { html: string }> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes)
    return { error: "TOO_LARGE" };
  if (!response.body) return { html: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  /* eslint-disable no-await-in-loop -- Stream chunks and cancellation are ordered. */
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      return { error: "TOO_LARGE" };
    }
    html += decoder.decode(chunk.value, { stream: true });
  }
  /* eslint-enable no-await-in-loop */
  return { html: html + decoder.decode() };
};

const fetchArticle = async (
  request: Extract<ReaderRequest, { action: "fetch" }>,
  fetchImplementation: ReaderFetch,
): Promise<ReaderResponse> => {
  let validated = validateArticleUrl(request.url);
  if ("error" in validated)
    return readerErrorResponse(request, validated.error);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /* eslint-disable no-await-in-loop -- Each fetch follows the previously validated redirect. */
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetchImplementation(validated.url, {
        credentials: "omit",
        redirect: "manual",
        referrer: "",
        signal: controller.signal,
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
      controller.signal.aborted ? "TIMEOUT" : "FETCH_FAILED",
    );
  } finally {
    clearTimeout(timer);
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
