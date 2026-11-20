import { extractFromHtml } from "@extractus/article-extractor";
import { Readability } from "@mozilla/readability";
import domPurify from "dompurify";
import { ReaderExtensionError } from "./extension-reader.ts";
import { readerMaximumHtmlBytes } from "#shared/reader-bridge.ts";
import { httpUrlWithoutCredentials } from "#shared/util/safe-url.ts";
import { mapSrcset } from "#shared/util/srcset.ts";

export type ReaderContent =
  | { content: string; kind: "html" }
  | { content: string; kind: "text" };
export type ReaderMode =
  | "ARTICLE_EXTRACTOR"
  | "READABILITY"
  | "READABILITY_PLAIN";

const maximumElements = 30_000;
const textEncoder = new TextEncoder();

const exceedsElementBudget = (html: string): boolean => {
  const startTag = /<[a-z]/gi;
  let elements = 0;
  while (startTag.test(html)) if (++elements > maximumElements) return true;
  return false;
};

const assertWithinBudget = (html: string): void => {
  if (
    textEncoder.encode(html).byteLength > readerMaximumHtmlBytes ||
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
    if (value)
      element.setAttribute(
        "srcset",
        mapSrcset(value, (url) => rewriteUrl(url, base)),
      );
  }
};

const validatedBaseUrl = (value: string): URL => {
  const url = httpUrlWithoutCredentials(value);
  if (!url) throw new ReaderExtensionError("INVALID_RESPONSE");
  return url;
};

const sanitizeExtractedHtml = (html: string, baseUrl: URL): string => {
  const extracted = new DOMParser().parseFromString(html, "text/html").body;
  rewriteDocumentUrls(extracted, baseUrl);
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
