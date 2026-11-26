import { mapSrcset } from "#shared/util/srcset.ts";

const processSrcset = (srcsetValue: string, baseUrl: string): string =>
  mapSrcset(srcsetValue, (url) => {
    if (URL.canParse(url)) return url;
    return URL.canParse(url, baseUrl) ? new URL(url, baseUrl).href : url;
  });

const rewriteUrlAttribute = (
  element: HTMLRewriterTypes.Element,
  attributeName: string,
  baseUrl: string,
): boolean => {
  const attributeValue = element.getAttribute(attributeName);
  if (!attributeValue) return false;
  if (URL.canParse(attributeValue)) return true;
  if (!URL.canParse(attributeValue, baseUrl)) return false;
  element.setAttribute(attributeName, new URL(attributeValue, baseUrl).href);
  return true;
};

const rewriteSrcsetAttribute = (
  element: HTMLRewriterTypes.Element,
  baseUrl: string,
): void => {
  const attributeValue = element.getAttribute("srcset");
  if (!attributeValue) return;
  element.setAttribute("srcset", processSrcset(attributeValue, baseUrl));
};

let activeArticleUrl = "";

const sharedRewriter = new HTMLRewriter()
  .on("a[href]", {
    element(element) {
      if (rewriteUrlAttribute(element, "href", activeArticleUrl)) {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    },
  })
  .on("img[src], img[srcset]", {
    element(element) {
      rewriteUrlAttribute(element, "src", activeArticleUrl);
      rewriteSrcsetAttribute(element, activeArticleUrl);
    },
  })
  .on("source[src], source[srcset]", {
    element(element) {
      rewriteUrlAttribute(element, "src", activeArticleUrl);
      rewriteSrcsetAttribute(element, activeArticleUrl);
    },
  })
  .on("video[src], video[poster]", {
    element(element) {
      rewriteUrlAttribute(element, "src", activeArticleUrl);
      rewriteUrlAttribute(element, "poster", activeArticleUrl);
    },
  })
  .on("audio[src]", {
    element(element) {
      rewriteUrlAttribute(element, "src", activeArticleUrl);
    },
  })
  .on("link[href]", {
    element(element) {
      rewriteUrlAttribute(element, "href", activeArticleUrl);
    },
  })
  .on("picture[srcset]", {
    element(element) {
      rewriteSrcsetAttribute(element, activeArticleUrl);
    },
  });

const rewritableTagPattern =
  /<(?:a|audio|video|img|link|source|picture)[\s/>]/i;

export const rewriteLinks = (content: string, articleUrl: string): string => {
  if (!rewritableTagPattern.test(content)) return content;
  activeArticleUrl = articleUrl;
  return sharedRewriter.transform(content);
};
