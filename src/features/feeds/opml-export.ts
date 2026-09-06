import type { OpmlNode } from "#shared/types/opml-types.ts";
import { xmlSafeText } from "#platform/xml.ts";

type XmlNode = {
  attributes?: Record<string, string>;
  children?: (string | XmlNode)[];
  name: string;
};

// The attributes parseOpml reads back: `text` for the name, `xmlUrl` for the
// feed and `htmlUrl` for the site. `title` is written alongside `text` because
// OPML 2.0 requires `text` and readers disagree about which they prefer, and
// `type="rss"` because a reader that only looks at the type attribute would
// otherwise take a feed for a folder.
function outline(node: OpmlNode): XmlNode {
  const name = xmlSafeText(node.name);
  if (node.type === "source") {
    return {
      attributes: {
        htmlUrl: xmlSafeText(node.homeUrl),
        text: name,
        title: name,
        type: "rss",
        xmlUrl: xmlSafeText(node.xmlUrl),
      },
      name: "outline",
    };
  }
  return {
    attributes: { text: name, title: name },
    children: node.children.map((child) => outline(child)),
    name: "outline",
  };
}

/**
 * An OPML 2.0 document for a subscription tree.
 *
 * Serialised by Bun.XML rather than concatenated: it escapes every attribute
 * and text node and refuses to emit anything that is not well-formed, so a
 * feed title containing `&` or `<` cannot produce a file no other reader will
 * open. The declaration is prepended as text, which is what stringify expects
 * -- it serialises one element and nothing around it.
 *
 * The explicit node shape rather than the compact one, because here document
 * order is an array rather than object key order: OPML requires `<head>`
 * before `<body>`, which is not something to leave to how the keys sort.
 */
export function buildOpml(title: string, nodes: OpmlNode[]): string {
  const document: XmlNode = {
    attributes: { version: "2.0" },
    children: [
      {
        children: [{ children: [xmlSafeText(title)], name: "title" }],
        name: "head",
      },
      { children: nodes.map((node) => outline(node)), name: "body" },
    ],
    name: "opml",
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${Bun.XML.stringify(document, null, 2)}\n`;
}
