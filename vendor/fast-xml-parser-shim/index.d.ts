/**
 * Types for the subset of fast-xml-parser this shim implements. The shape is
 * fast-xml-parser's `preserveOrder` format: each node is keyed by its tag
 * name and holds its children in document order, with attributes under ":@"
 * and character data under "#text".
 */
export type XmlNode = {
  [tagName: string]: XmlNode[] | Record<string, string> | string | undefined;
  ":@"?: Record<string, string>;
  "#text"?: string;
};

export class XMLParser {
  /** Throws on malformed XML; Bun.XML is a conforming processor. */
  parse(xml: string): XmlNode[];
}

export class XMLBuilder {
  build(nodes: XmlNode[]): string;
}
