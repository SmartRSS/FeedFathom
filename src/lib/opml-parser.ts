import { logError } from "../util/log";
import { XMLParser } from "fast-xml-parser";

export type OpmlNode = OpmlFolder | OpmlSource;
type OpmlFolder = {
  children: OpmlNode[];
  name: string;
  type: "folder";
};

type OpmlSource = {
  homeUrl: string;
  name: string;
  type: "source";
  xmlUrl: string;
};

type Outline = {
  "@_": {
    [key: string]: string;
    htmlUrl?: string;
    title?: string;
    type?: string;
    xmlUrl?: string;
  };
  [key: string]: unknown;
  outline?: Outline[];
};

const expectedTypes = ["atom", "rdf", "rss"];

const processOutline = (outline: Outline): OpmlNode => {
  const title = outline["@_"]?.title ?? "Unknown";
  const type = outline["@_"]?.type ?? "";
  const xmlUrl = outline["@_"]?.xmlUrl ?? "";
  const homeUrl = outline["@_"]?.htmlUrl ?? "";

  if (expectedTypes.includes(type) || xmlUrl) {
    return {
      homeUrl: (() => {
        if (homeUrl) {
          return homeUrl;
        }

        if (URL.canParse(xmlUrl)) {
          return new URL(xmlUrl).origin;
        }

        return "";
      })(),
      name: title,
      type: "source",
      xmlUrl,
    };
  }

  const children = outline.outline?.map(processOutline) ?? [];
  return {
    children,
    name: title,
    type: "folder",
  };
};

export class OpmlParser {
  async parseOpml(opml: string): Promise<OpmlNode[]> {
    const parser = new XMLParser({
      allowBooleanAttributes: true,
      alwaysCreateTextNode: true,
      attributeNamePrefix: "",
      attributesGroupName: "@_",
      ignoreAttributes: false,
    });
    try {
      const object = parser.parse(opml);
      const mainOutline = object.opml?.body?.outline as
        | null
        | Outline
        | Outline[];

      if (!mainOutline) {
        throw new Error("Invalid OPML: missing outline element");
      }

      return Array.isArray(mainOutline)
        ? mainOutline.map(processOutline)
        : [processOutline(mainOutline)];
    } catch (error) {
      logError("Error while parsing OPML:", error);
      throw error;
    }
  }
}
