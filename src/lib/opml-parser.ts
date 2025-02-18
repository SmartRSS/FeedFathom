import {
  type OpmlFolder,
  type OpmlSource,
  type Outline,
} from "../types/opml-types";
import { logError } from "../util/log";
import { XMLParser } from "fast-xml-parser";

export class OpmlParser {
  async parseOpml(opml: string): Promise<Array<OpmlFolder | OpmlSource>> {
    const parser = new XMLParser({
      allowBooleanAttributes: true,
      alwaysCreateTextNode: true,
      attributeNamePrefix: "",
      attributesGroupName: "@_",
      ignoreAttributes: false,
    });
    try {
      const object = parser.parse(opml);
      const mainOutline = object.opml.body.outline;

      return mainOutline.map((outline: Outline) => {
        return this.processOutline(outline);
      });
    } catch (error) {
      logError("Error while parsing OPML:", error);
      throw error;
    }
  }

  processOutline(outline: Outline): OpmlFolder | OpmlSource {
    const title = outline["@_"]?.["title"] ?? "Unknown";
    const type = outline["@_"]?.["type"] ?? "";
    const xmlUrl = outline["@_"]?.["xmlUrl"] ?? "";
    const homeUrl = outline["@_"]?.["htmlUrl"] ?? "";

    if (["atom", "jsonfeed", "rdf", "rss"].includes(type) || xmlUrl) {
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

    const children =
      outline.outline?.map((child) => {
        return this.processOutline(child);
      }) ?? [];
    return {
      children,
      name: title,
      type: "folder",
    };
  }
}
