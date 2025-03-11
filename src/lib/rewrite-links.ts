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

const isAbsoluteUrl = (url: string) => {
  return URL.canParse(url);
};

const srcsetSplitterExpression = /\s+/u;

// Helper to process "srcset" attributes
const processSrcset = (srcsetValue: string, baseUrl: string): string => {
  return srcsetValue
    .split(", ")
    .map((path) => {
      const [url, width] = path.trim().split(srcsetSplitterExpression);
      if (!url) {
        // Fall back to the original value if the URL is invalid
        return path;
      }

      if (isAbsoluteUrl(url)) {
        return width ? `${url} ${width}` : url;
      }

      if (URL.canParse(url, baseUrl)) {
        const absoluteUrl = new URL(url, baseUrl).href;
        return width ? `${absoluteUrl} ${width}` : absoluteUrl;
      }

      // Return original if no valid URL
      return path;
    })
    .join(", ");
};

// New function to handle element processing
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
    // Special handling for "srcset"
    const processedSrcset = processSrcset(attributeValue, articleUrl);
    element.setAttribute(attributeName, processedSrcset);
    // Early return after processing srcset
    return;
  }

  // General handling for src, href, etc.
  if (isAbsoluteUrl(attributeValue)) {
    if (tagName === "a") {
      element.setAttribute("target", "_blank");
    }

    // no need to change anything
    return;
  }

  if (URL.canParse(attributeValue, articleUrl)) {
    const absoluteUrl = new URL(attributeValue, articleUrl).href;
    element.setAttribute(attributeName, absoluteUrl);
    if (tagName === "a") {
      element.setAttribute("target", "_blank");
    }
  }
};

export const rewriteLinks = (content: string, articleUrl: string) => {
  let rewriter: HTMLRewriter | null = new HTMLRewriter();
  for (const [tagName, attributeName] of tagAttributePairs) {
    rewriter.on(`${tagName}[${attributeName}]`, {
      element: (element) => {
        handleElement(element, tagName, attributeName, articleUrl);
      },
    });
  }

  const result = rewriter.transform(content);
  rewriter = null;
  return result;
};
