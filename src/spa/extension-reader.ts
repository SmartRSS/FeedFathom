import { extractFromHtml } from "@extractus/article-extractor";
import { Readability } from "@mozilla/readability";
import domPurify from "dompurify";
import {
  isReaderResponse,
  readerBridgeChannel,
  readerBridgeVersion,
  type ReaderErrorCode,
  type ReaderRequest,
  type ReaderResponse,
} from "../extension/extension-types.ts";

const responseTimeoutMs = 20_000;

const errorMessages: Record<ReaderErrorCode, string> = {
  FETCH_FAILED: "The Reader extension could not fetch this article.",
  INVALID_RESPONSE: "The Reader extension returned an invalid response.",
  INVALID_URL: "This article has an invalid URL.",
  NOT_HTML: "This article is not an HTML document.",
  PRIVATE_URL: "The Reader extension refused a private network address.",
  TIMEOUT: "The Reader extension timed out fetching this article.",
  TOO_LARGE: "This article is too large for Reader mode.",
  TOO_MANY_REDIRECTS: "This article redirected too many times.",
  UNAUTHORIZED: "The Reader extension is configured for another instance.",
  UNAVAILABLE: "The Reader extension is unavailable.",
};

export class ReaderExtensionError extends Error {
  constructor(
    readonly code: ReaderErrorCode,
    message = errorMessages[code],
  ) {
    super(message);
  }

  get unavailable(): boolean {
    return (
      this.code === "TIMEOUT" ||
      this.code === "UNAUTHORIZED" ||
      this.code === "UNAVAILABLE"
    );
  }
}

type PendingRequest = {
  reject(error: Error): void;
  request: ReaderRequest;
  resolve(response: ReaderResponse): void;
  timer: ReturnType<typeof setTimeout>;
};

export type ReaderContent =
  | { content: string; kind: "html" }
  | { content: string; kind: "text" };
export type ReaderMode =
  | "ARTICLE_EXTRACTOR"
  | "READABILITY"
  | "READABILITY_PLAIN";

/**
 * Reader flow: SPA window → content script → extension background → direct
 * extension fetch → validated response. Reader documents must never be
 * proxied through the FeedFathom backend; availability also proves that the
 * extension is configured for this SPA origin.
 */
export const createExtensionReaderBridge = (windowObject: Window = window) => {
  const pending = new Map<string, PendingRequest>();

  const receive = (event: MessageEvent<unknown>) => {
    if (
      event.source !== windowObject ||
      event.origin !== windowObject.location.origin ||
      !isReaderResponse(event.data)
    )
      return;
    const request = pending.get(event.data.id);
    if (!request || request.request.action !== event.data.action) return;
    pending.delete(event.data.id);
    clearTimeout(request.timer);
    request.resolve(event.data);
  };
  windowObject.addEventListener("message", receive);

  const send = (request: ReaderRequest): Promise<ReaderResponse> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        reject(new ReaderExtensionError("UNAVAILABLE"));
      }, responseTimeoutMs);
      pending.set(request.id, { reject, request, resolve, timer });
      windowObject.postMessage(request, windowObject.location.origin);
    });

  return {
    async available(): Promise<boolean> {
      const request: ReaderRequest = {
        action: "capabilities",
        channel: readerBridgeChannel,
        id: crypto.randomUUID(),
        type: "request",
        version: readerBridgeVersion,
      };
      try {
        const response = await send(request);
        return response.ok && response.action === "capabilities";
      } catch {
        return false;
      }
    },
    dispose(): void {
      windowObject.removeEventListener("message", receive);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(errorMessages.UNAVAILABLE));
      }
      pending.clear();
    },
    async fetch(url: string): Promise<{ finalUrl: string; html: string }> {
      const request: ReaderRequest = {
        action: "fetch",
        channel: readerBridgeChannel,
        id: crypto.randomUUID(),
        type: "request",
        url,
        version: readerBridgeVersion,
      };
      const response = await send(request);
      if (!response.ok) throw new ReaderExtensionError(response.error);
      if (response.action !== "fetch")
        throw new ReaderExtensionError("INVALID_RESPONSE");
      return { finalUrl: response.finalUrl, html: response.html };
    },
  };
};

const rewriteUrl = (value: string, base: URL): string => {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
};

const rewriteDocumentUrls = (root: ParentNode, base: URL): void => {
  for (const element of root.querySelectorAll(
    "[action], [cite], [href], [poster], [src]",
  ))
    for (const attribute of ["action", "cite", "href", "poster", "src"]) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, rewriteUrl(value, base));
    }

  for (const element of root.querySelectorAll("[srcset]")) {
    const value = element.getAttribute("srcset");
    if (!value || value.includes("data:")) continue;
    element.setAttribute(
      "srcset",
      value
        .split(",")
        .map((candidate) => {
          const [url, ...descriptor] = candidate.trim().split(/\s+/);
          return url
            ? [rewriteUrl(url, base), ...descriptor].join(" ")
            : candidate;
        })
        .join(", "),
    );
  }
};

const validatedBaseUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(errorMessages.INVALID_RESPONSE);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new Error(errorMessages.INVALID_RESPONSE);
  return url;
};

// Shared by every HTML-producing extractor: rewrites relative URLs against
// the article's real address, then strips anything DOMPurify considers
// unsafe -- extracted content is still attacker-controlled HTML from an
// arbitrary site, extractor choice doesn't change that.
const sanitizeExtractedHtml = (html: string, baseUrl: URL): string => {
  const extracted = document.createElement("body");
  extracted.innerHTML = html;
  rewriteDocumentUrls(extracted, baseUrl);
  return domPurify(window).sanitize(extracted.innerHTML, {
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["style"],
  });
};

const extractWithReadability = (
  document_: Document,
  baseUrl: URL,
  mode: "READABILITY" | "READABILITY_PLAIN",
): ReaderContent => {
  for (const base of document_.querySelectorAll("base")) base.remove();
  const trustedBase = document_.createElement("base");
  trustedBase.href = baseUrl.href;
  document_.head.append(trustedBase);

  const article = new Readability(document_).parse();
  if (!article) throw new Error("Reader could not extract this article.");
  return mode === "READABILITY_PLAIN"
    ? { content: article.textContent ?? "", kind: "text" }
    : {
        content: sanitizeExtractedHtml(article.content ?? "", baseUrl),
        kind: "html",
      };
};

// @extractus/article-extractor: a different heuristic set (falls back to
// meta tags/OpenGraph data more readily than Readability), offered as a
// manual alternative in the mode picker for articles Readability mangles.
// Its own DOM calls are all standard APIs -- see vendor/linkedom-shim --
// so this runs against the browser's native parser, not a second copy of
// Readability's own dependency.
const extractWithArticleExtractor = async (
  html: string,
  finalUrl: string,
  baseUrl: URL,
): Promise<ReaderContent> => {
  const article = await extractFromHtml(html, finalUrl);
  if (!article?.content)
    throw new Error("Reader could not extract this article.");
  return {
    content: sanitizeExtractedHtml(article.content, baseUrl),
    kind: "html",
  };
};

export const extractReaderContent = async (
  html: string,
  finalUrl: string,
  mode: ReaderMode,
): Promise<ReaderContent> => {
  const baseUrl = validatedBaseUrl(finalUrl);
  if (mode === "ARTICLE_EXTRACTOR")
    return extractWithArticleExtractor(html, finalUrl, baseUrl);
  return extractWithReadability(
    new DOMParser().parseFromString(html, "text/html"),
    baseUrl,
    mode,
  );
};
