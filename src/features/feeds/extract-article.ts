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

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    audio: ["controls", "src"],
    img: [
      "alt",
      "decoding",
      "height",
      "loading",
      "sizes",
      "src",
      "srcset",
      "title",
      "width",
    ],
    source: ["sizes", "src", "srcset", "type"],
    video: ["controls", "height", "poster", "src", "width"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedTags,
  transformTags: {
    a: (tagName, attribs) => ({
      attribs: { ...attribs, rel: "noopener noreferrer" },
      tagName,
    }),
    img: (tagName, attribs) => ({
      attribs: { decoding: "async", loading: "lazy", ...attribs },
      tagName,
    }),
  },
};

export const sanitizerVersion = 1;

export const extractArticle = (content: null | string | undefined) =>
  sanitizeHtml(content ?? "", sanitizeOptions);
