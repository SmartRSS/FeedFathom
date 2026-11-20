import type { OpmlNode } from "#features/feeds/opml-types.ts";
import { xmlSafeText } from "#features/feeds/xml.ts";

type XmlNode = {
  attributes?: Record<string, string>;
  children?: (string | XmlNode)[];
  name: string;
};

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
