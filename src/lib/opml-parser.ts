import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { OpmlFolder, OpmlNode, OpmlSource } from "../types/opml-types.ts";

const maximumDepth = 32;
const maximumNodes = 10_000;
const sourceTypes = new Set(["atom", "jsonfeed", "rdf", "rss"]);

type RecordValue = Record<string, unknown>;
type RawOutline = {
  attributes: RecordValue;
  children: unknown[];
};
type PendingOutline = {
  depth: number;
  target: OpmlNode[];
  value: unknown;
};

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringAttribute = (attributes: RecordValue, name: string): string => {
  const value = attributes[name];
  return typeof value === "string" ? value : "";
};

const rawOutline = (value: unknown): RawOutline => {
  if (!isRecord(value)) throw new Error("Invalid OPML outline");
  // Missing/malformed attributes or a non-array children list don't make
  // the node unrecoverable -- fall back to empty rather than losing this
  // node's (and its children's) entire subtree over one bad property.
  const attributes = isRecord(value["@_"]) ? value["@_"] : {};
  const children = value["outline"];
  return {
    attributes,
    children: Array.isArray(children) ? children : [],
  };
};

const webUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

export class OpmlParser {
  parseOpml(opml: string): OpmlNode[] {
    if (XMLValidator.validate(opml) !== true)
      throw new Error("Invalid OPML XML");
    const parser = new XMLParser({
      allowBooleanAttributes: true,
      alwaysCreateTextNode: true,
      attributeNamePrefix: "",
      attributesGroupName: "@_",
      ignoreAttributes: false,
      isArray: (name) => name === "outline",
    });
    const parsed: unknown = parser.parse(opml);
    if (!isRecord(parsed) || !isRecord(parsed["opml"]))
      throw new Error("Invalid OPML document");
    const body = parsed["opml"]["body"];
    if (!isRecord(body)) throw new Error("Invalid OPML body");
    const outlines = body["outline"];
    if (outlines === undefined) return [];
    if (!Array.isArray(outlines)) throw new Error("Invalid OPML outlines");
    return this.processOutlines(outlines);
  }

  processOutline(outline: unknown): OpmlFolder | OpmlSource {
    const [result] = this.processOutlines([outline]);
    if (!result) throw new Error("Invalid OPML outline");
    return result;
  }

  private processOutlines(outlines: unknown[]): OpmlNode[] {
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

      let outline: RawOutline;
      try {
        outline = rawOutline(current.value);
      } catch {
        // A single malformed outline node shouldn't abort the whole
        // import -- skip it and keep processing the rest of the file.
        continue;
      }
      const title =
        stringAttribute(outline.attributes, "title") ||
        stringAttribute(outline.attributes, "text") ||
        "Unknown";
      const type = stringAttribute(outline.attributes, "type").toLowerCase();
      const xmlUrl = stringAttribute(outline.attributes, "xmlUrl");

      if (sourceTypes.has(type) || xmlUrl) {
        const parsedXmlUrl = webUrl(xmlUrl);
        // A single malformed feed URL shouldn't abort the whole import --
        // skip just this outline and keep processing the rest of the file.
        if (!parsedXmlUrl) continue;
        const homeUrl = stringAttribute(outline.attributes, "htmlUrl");
        const parsedHomeUrl = webUrl(homeUrl);
        current.target.push({
          homeUrl: parsedHomeUrl ? homeUrl : parsedXmlUrl.origin,
          name: title,
          type: "source",
          xmlUrl,
        });
        continue;
      }

      const folder: OpmlFolder = { children: [], name: title, type: "folder" };
      current.target.push(folder);
      for (const child of outline.children.toReversed())
        pending.push({
          depth: current.depth + 1,
          target: folder.children,
          value: child,
        });
    }

    return result;
  }
}
