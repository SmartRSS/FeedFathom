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

export const rewriteLinks = (content: string, articleUrl: string) => {
  let rewriter: HTMLRewriter | null = new HTMLRewriter();
  for (const [tagName, attributeName] of tagAttributePairs) {
    rewriter.on(`${tagName}[${attributeName}]`, {
      element: (element) =>
        {return handleElement(element, tagName, attributeName, articleUrl)},
    });
  }

  const result = rewriter.transform(content);
  rewriter = null;
  return result;
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
    return; // Early return after processing srcset
  }

  // General handling for src, href, etc.
  if (isAbsoluteUrl(attributeValue)) {
    if (tagName === "a") {
      element.setAttribute("target", "_blank");
    }

    return; // no need to change anything
  }

  if (URL.canParse(attributeValue, articleUrl)) {
    const absoluteUrl = new URL(attributeValue, articleUrl).href;
    element.setAttribute(attributeName, absoluteUrl);
    if (tagName === "a") {
      element.setAttribute("target", "_blank");
    }
  }
};

// Helper to process "srcset" attributes
const processSrcset = (srcsetValue: string, baseUrl: string): string => {
  return srcsetValue
    .split(",")
    .map((path) => {
      const [url, width] = path.trim().split(/\s+/);
      if (!url) {
        return path; // Fall back to the original value if the URL is invalid
      }

      if (isAbsoluteUrl(url)) {
        return width ? `${url} ${width}` : url;
      }

      if (URL.canParse(url, baseUrl)) {
        const absoluteUrl = new URL(url, baseUrl).href;
        return width ? `${absoluteUrl} ${width}` : absoluteUrl;
      }

      return path; // Return original if no valid URL
    })
    .join(", ");
};

const isAbsoluteUrl = (url: string) => {
  return URL.canParse(url);
};
