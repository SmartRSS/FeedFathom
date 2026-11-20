export type XmlNode = {
  [tagName: string]: XmlNode[] | Record<string, string> | string | undefined;
  ":@"?: Record<string, string>;
  "#text"?: string;
};

export class XMLParser {
  parse(xml: string): XmlNode[];
}

export class XMLBuilder {
  build(nodes: XmlNode[]): string;
}
