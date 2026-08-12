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
      a: ["href", "name", "target", "rel"],
      audio: ["controls", "src"],
      img: ["alt", "height", "loading", "src", "srcset", "title", "width"],
      source: ["src", "srcset", "type"],
      video: ["controls", "height", "poster", "src", "width"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedTags,
    // allowedAttributes only lets the "rel" attribute *name* through, not its
    // value: content that never passes through rewrite-links.ts (email
    // articles bypass it entirely) could otherwise carry an attacker-chosen
    // rel="opener" that actively re-enables window.opener access. Force the
    // safe value on every link unconditionally (harmless on links that don't
    // open a new tab) rather than trying to detect target="_blank" first --
    // that match previously missed case variants like target="_BLANK".
    transformTags: {
      a: (tagName, attribs) => ({
        attribs: { ...attribs, rel: "noopener noreferrer" },
        tagName,
      }),
    },
  });
