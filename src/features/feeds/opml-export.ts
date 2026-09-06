import type { OpmlNode } from "#shared/types/opml-types.ts";
import { escapeXml } from "#platform/xml.ts";

// The attributes parseOpml reads back: `text` for the name, `xmlUrl` for the
// feed and `htmlUrl` for the site. `title` is written alongside `text`
// because OPML 2.0 requires `text` and readers disagree about which they
// prefer, and `type="rss"` because a reader that only looks at the type
// attribute would otherwise take a feed for a folder.
function outline(node: OpmlNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const name = escapeXml(node.name);
  if (node.type === "source") {
    return `${indent}<outline type="rss" text="${name}" title="${name}" xmlUrl="${escapeXml(node.xmlUrl)}" htmlUrl="${escapeXml(node.homeUrl)}"/>`;
  }
  if (node.children.length === 0) {
    return `${indent}<outline text="${name}" title="${name}"/>`;
  }
  return [
    `${indent}<outline text="${name}" title="${name}">`,
    ...node.children.map((child) => outline(child, depth + 1)),
    `${indent}</outline>`,
  ].join("\n");
}

/** An OPML 2.0 document for a subscription tree. */
export function buildOpml(title: string, nodes: OpmlNode[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    `    <title>${escapeXml(title)}</title>`,
    "  </head>",
    "  <body>",
    ...nodes.map((node) => outline(node, 2)),
    "  </body>",
    "</opml>",
    "",
  ].join("\n");
}
