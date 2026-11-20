import type { OpmlFolder, OpmlNode } from "#features/feeds/opml-types.ts";
import {
  attribute,
  childElements,
  isXmlElement,
  parseXml,
} from "#features/feeds/xml.ts";
import { isWebUrl } from "#shared/validation/address-shape.ts";
import { decodeHtmlReferences } from "#features/feeds/plain-text.ts";

const maximumDepth = 32;
const maximumNodes = 10_000;
const sourceTypes = new Set(["atom", "jsonfeed", "rdf", "rss"]);

type PendingOutline = {
  depth: number;
  target: OpmlNode[];
  value: unknown;
};

export function parseOpml(opml: string): OpmlNode[] {
  const parsed = parseXml(opml);
  const root = parsed["opml"];
  if (!isXmlElement(root)) throw new Error("Invalid OPML document");
  const body = root["body"];
  if (body === undefined) throw new Error("Invalid OPML body");
  if (!isXmlElement(body)) return [];
  return processOutlines(childElements(body, "outline"));
}

function processOutlines(outlines: unknown[]): OpmlNode[] {
  const result: OpmlNode[] = [];
  const pending: PendingOutline[] = outlines
    .toReversed()
    .map((value) => ({ depth: 1, target: result, value }));
  let nodes = 0;

  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    nodes++;
    if (nodes > maximumNodes) throw new Error("OPML contains too many nodes");
    if (current.depth > maximumDepth)
      throw new Error("OPML nesting is too deep");

    const outline = current.value;
    if (!isXmlElement(outline)) continue;

    const title = decodeHtmlReferences(
      attribute(outline, "title") || attribute(outline, "text") || "Unknown",
    );
    const type = attribute(outline, "type").toLowerCase();
    const xmlUrl = attribute(outline, "xmlUrl");

    if (sourceTypes.has(type) || xmlUrl) {
      if (!isWebUrl(xmlUrl)) continue;
      const homeUrl = attribute(outline, "htmlUrl");
      current.target.push({
        homeUrl: isWebUrl(homeUrl) ? homeUrl : new URL(xmlUrl).origin,
        name: title,
        type: "source",
        xmlUrl,
      });
      continue;
    }

    const folder: OpmlFolder = { children: [], name: title, type: "folder" };
    current.target.push(folder);
    for (const child of childElements(outline, "outline").toReversed())
      pending.push({
        depth: current.depth + 1,
        target: folder.children,
        value: child,
      });
  }

  return result;
}
