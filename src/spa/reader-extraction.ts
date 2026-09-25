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

// Extraction runs on the main thread, so it must stay short enough that a
// click to switch away is still answered. The extension already refuses
// documents over 5 MiB; these tighter budgets send larger pages to Feed mode
// before any parsing starts. The largest Wikipedia articles (about 2.8 MB and
// 23,000 elements) still fit; a 3.8 MB page of 24,000 linked paragraphs,
// which held the thread for about 465 ms, does not.
// UTF-8 bytes, measured with TextEncoder rather than html.length, so a
// non-Latin-script page (Polish, Cyrillic, CJK) is budgeted by its real
// transfer size instead of its UTF-16 code-unit count.
const maximumHtmlBytes = 3 * 1024 * 1024;
const maximumElements = 30_000;
const textEncoder = new TextEncoder();

// Counts start tags in the source, so the element budget is enforced without
// building a DOM. Tags inside scripts and comments count too, which only errs
// towards the fallback.
const exceedsElementBudget = (html: string): boolean => {
  const startTag = /<[a-z]/gi;
  let elements = 0;
  while (startTag.test(html)) if (++elements > maximumElements) return true;
  return false;
};

const assertWithinBudget = (html: string): void => {
  if (
    textEncoder.encode(html).byteLength > maximumHtmlBytes ||
    exceedsElementBudget(html)
  )
    throw new ReaderExtensionError("TOO_LARGE");
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
    // Backstop for elements the source count cannot see, such as the ones
    // the parser adds itself.
    article = new Readability(document_, {
      maxElemsToParse: maximumElements,
    }).parse();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Aborting parsing document")
    )
      throw new ReaderExtensionError("TOO_LARGE");
    throw error;
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
  assertWithinBudget(html);
  if (mode === "ARTICLE_EXTRACTOR")
    return extractWithArticleExtractor(html, finalUrl, baseUrl);
  return extractWithReadability(
    new DOMParser().parseFromString(html, "text/html"),
    baseUrl,
    mode,
  );
};
