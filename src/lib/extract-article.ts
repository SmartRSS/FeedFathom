import sanitizeHtml from "sanitize-html";

const allowedTags = [
  ...sanitizeHtml.defaults.allowedTags,
  "audio",
  "figcaption",
  "figure",
  "img",
  "picture",
  "source",
  "video",
];

export const extractArticle = (content: null | string | undefined) =>
  sanitizeHtml(content ?? "", {
    allowedAttributes: {
      a: ["href", "name", "target"],
      audio: ["controls", "src"],
      img: ["alt", "height", "loading", "src", "srcset", "title", "width"],
      source: ["src", "srcset", "type"],
      video: ["controls", "height", "poster", "src", "width"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedTags,
  });
