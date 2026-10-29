const tagAttributePairs = [
  ["a", "href"],
  ["audio", "src"],
  ["video", "src"],
  ["video", "poster"],
  ["img", "src"],
  ["img", "srcset"],
  ["link", "href"],
  ["source", "src"],
  ["source", "srcset"],
  ["picture", "srcset"],
] as const;

const srcsetSplitterExpression = /\s+/u;
// A candidate ends at a comma followed by whitespace or one right after its
// descriptor; a comma inside the URL itself, as in a data: URI, splits nothing.
const srcsetCandidateSeparator = /\s*,\s+|(?<=\s[\d.]+[hwx]),\s*/u;

const processSrcset = (srcsetValue: string, baseUrl: string): string =>
  srcsetValue
    .trim()
    .split(srcsetCandidateSeparator)
    .filter(Boolean)
    .map((path) => {
      const [url, width] = path.split(srcsetSplitterExpression);
      if (!url || !URL.canParse(url, baseUrl)) return path;
      const absoluteUrl = URL.canParse(url) ? url : new URL(url, baseUrl).href;
      return width ? `${absoluteUrl} ${width}` : absoluteUrl;
    })
    .join(", ");

const handleElement = (
  element: HTMLRewriterTypes.Element,
  tagName: string,
  attributeName: string,
  articleUrl: string,
) => {
  const attributeValue = element.getAttribute(attributeName);
  if (!attributeValue) {
    return;
  }

  if (attributeName === "srcset") {
    element.setAttribute(
      attributeName,
      processSrcset(attributeValue, articleUrl),
    );
    return;
  }

  if (!URL.canParse(attributeValue, articleUrl)) return;
  if (!URL.canParse(attributeValue)) {
    element.setAttribute(
      attributeName,
      new URL(attributeValue, articleUrl).href,
    );
  }
  if (tagName === "a") {
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noopener noreferrer");
  }
};

export const rewriteLinks = (content: string, articleUrl: string) => {
  const rewriter = new HTMLRewriter();
  for (const [tagName, attributeName] of tagAttributePairs) {
    rewriter.on(`${tagName}[${attributeName}]`, {
      element: (element) => {
        handleElement(element, tagName, attributeName, articleUrl);
      },
    });
  }
  return rewriter.transform(content);
};
