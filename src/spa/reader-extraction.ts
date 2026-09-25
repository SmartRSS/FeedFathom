// The extraction half of Reader mode. Readability, article-extractor and
// DOMPurify are needed only once Reader mode is in use, so the dashboard loads
// this module with import() and keeps them out of the main SPA chunk.
import { extractFromHtml } from "@extractus/article-extractor";
import { Readability } from "@mozilla/readability";
import domPurify from "dompurify";
import {
  ReaderExtensionError,
  type ReaderContent,
  type ReaderMode,
} from "./extension-reader.ts";

// Extraction runs synchronously on the main thread, so a large page blocks
// every click until it finishes. These bound that pause well below the
// extension's 5 MiB fetch limit; a long article with its page chrome sits far
// under both. A page over either falls back to Feed mode as TOO_LARGE.
// ponytail: main-thread budget; extraction in a separate execution context
// would lift it.
const maximumInteractiveBytes = 2 * 1024 * 1024;
const maximumElements = 20_000;

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
    throw new ReaderExtensionError("INVALID_RESPONSE");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new ReaderExtensionError("INVALID_RESPONSE");
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
  // Same reason as the server-side sanitizer in extract-article.ts: a whole
  // extracted page lands in a pane the reader scrolls, so the images below
  // the fold should not all fetch on open. Only images the page did not
  // already give a hint of its own, and both attributes survive DOMPurify's
  // default allowlist.
  for (const image of extracted.querySelectorAll("img")) {
    if (!image.hasAttribute("loading")) image.setAttribute("loading", "lazy");
    if (!image.hasAttribute("decoding"))
      image.setAttribute("decoding", "async");
  }
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

  let article: ReturnType<Readability["parse"]>;
  try {
    article = new Readability(document_, {
      maxElemsToParse: maximumElements,
    }).parse();
  } catch {
    // parse()'s only runtime throw is the maxElemsToParse abort.
    throw new ReaderExtensionError("TOO_LARGE");
  }
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
// Runs against the browser's native parser rather than a second pure-JS DOM
// -- see vendor/linkedom-shim, which is nearly all standard API and one
// documented divergence over how a fragment is rooted.
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
  if (new Blob([html]).size > maximumInteractiveBytes)
    throw new ReaderExtensionError("TOO_LARGE");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  if (mode === "ARTICLE_EXTRACTOR") {
    // article-extractor reparses the page several times and takes no element
    // limit of its own, so the one Readability gets is checked here instead.
    if (parsed.getElementsByTagName("*").length > maximumElements)
      throw new ReaderExtensionError("TOO_LARGE");
    return extractWithArticleExtractor(html, finalUrl, baseUrl);
  }
  return extractWithReadability(parsed, baseUrl, mode);
};
