import * as cheerio from "cheerio";

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

export const linkFixer = (content: string, articleUrl: string) => {
  const $ = cheerio.load(content, null, false); // Load HTML content

  // Iterate through tag-attribute pairs
  tagAttributePairs.forEach(([tagName, attrName]) => {
    $(tagName).each((_index, element) => {
      const $elem = $(element);

      // Handle anchors <a> to add target="_blank"
      if (tagName === "a") {
        const hrefAttribute = $elem.attr(attrName);
        if (hrefAttribute && URL.canParse(hrefAttribute)) {
          $elem.attr("target", "_blank");
        }
      }

      // Process other attributes
      const attrValue = $elem.attr(attrName);
      if (attrValue) {
        if (attrName === "srcset") {
          // Special handling for "srcset"
          const processedSrcset = processSrcset(attrValue, articleUrl);
          $elem.attr(attrName, processedSrcset);
        } else {
          if (URL.canParse(attrValue)) {
            return;
          }
          // General handling for src, href, etc.
          try {
            const absoluteUrl = new URL(attrValue, articleUrl).href;
            $elem.attr(attrName, absoluteUrl);
          } catch {
            console.error(
              `Invalid URL for ${tagName} (${attrName}): ${attrValue}`,
            );
          }
        }
      }
    });
  });

  // Serialize back the modified HTML
  return $.html();
};

// Helper to process "srcset" attributes
const processSrcset = (srcsetValue: string, baseUrl: string): string => {
  const paths = srcsetValue.split(",");
  const processedPaths = paths.map((path) => {
    const [url, width] = path.trim().split(/\s+/);
    if (!url) {
      return path; // Fall back to the original value if the URL is invalid
    }
    try {
      // Convert relative to absolute URL
      const absoluteUrl = new URL(url, baseUrl).href;
      return width ? `${absoluteUrl} ${width}` : absoluteUrl;
    } catch {
      console.error(`Invalid URL in srcset: ${url}`);
      return path;
    }
  });
  return processedPaths.join(", ");
};

const tagAttributeMap = {
  a: ["href"],
  audio: ["src"],
  video: ["src", "poster"],
  img: ["src", "srcset"],
  link: ["href"],
  source: ["src", "srcset"],
  picture: ["srcset"],
} as const;

export const rewriteLinks = (content: string, articleUrl: string) => {
  const rewriter = new HTMLRewriter();
  for (const tag in tagAttributeMap) {
    // Type assertion to ensure 'tag' is a key of 'tagAttributeMap'
    rewriter.on(tag as keyof typeof tagAttributeMap, {
      element(element) {
        if (tag === "a") {
          const hrefAttribute = element.getAttribute("href");
          if (hrefAttribute) {
            try {
              const hrefUrl = new URL(hrefAttribute);
              if (["http:", "https:", "ftp:"].includes(hrefUrl.protocol)) {
                element.setAttribute("target", "_blank");
              }
            } catch {
              //nop
            }
          }
        }
        for (const attribute of tagAttributeMap[
          tag as keyof typeof tagAttributeMap
        ]) {
          // Process each attribute as needed
          const attrValue = element.getAttribute(attribute);
          if (attrValue) {
            if (attribute === "srcset") {
              // Special handling for "srcset"
              const processedSrcset = processSrcset(attrValue, articleUrl);
              element.setAttribute(attribute, processedSrcset);
            } else {
              // General handling for src, href, etc.
              try {
                const absoluteUrl = new URL(attrValue, articleUrl).href;
                element.setAttribute(attribute, absoluteUrl);
              } catch {
                console.error(
                  `Invalid URL for ${tag} (${attribute}): ${attrValue}`,
                );
              }
            }
          }
        }
      },
    });
  }
  return rewriter.transform(content);
};
