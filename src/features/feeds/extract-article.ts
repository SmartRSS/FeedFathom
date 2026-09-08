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
      img: [
        "alt",
        "decoding",
        "height",
        "loading",
        "src",
        "srcset",
        "title",
        "width",
      ],
      source: ["src", "srcset", "type"],
      video: ["controls", "height", "poster", "src", "width"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedTags,
    transformTags: {
      // allowedAttributes only lets the "rel" attribute *name* through, not
      // its value: content that never passes through rewrite-links.ts (email
      // articles bypass it entirely) could otherwise carry an attacker-chosen
      // rel="opener" that actively re-enables window.opener access. Force the
      // safe value on every link unconditionally (harmless on links that don't
      // open a new tab) rather than trying to detect target="_blank" first --
      // that match previously missed case variants like target="_BLANK".
      a: (tagName, attribs) => ({
        attribs: { ...attribs, rel: "noopener noreferrer" },
        tagName,
      }),
      // A feed body is written for a page, not for a pane, and an image-heavy
      // article otherwise fetches every image the moment it is opened --
      // including the ones twenty screens down that will never be reached.
      // The reader is an overflow scroller, and an image an ancestor scroller
      // clips is not intersecting the viewport, so lazy holds there too. A
      // feed that already said loading="eager" is left alone: the tag is the
      // author's, and forcing it would be this sanitizer overruling content
      // rather than bounding it.
      img: (tagName, attribs) => ({
        attribs: { decoding: "async", loading: "lazy", ...attribs },
        tagName,
      }),
    },
  });
