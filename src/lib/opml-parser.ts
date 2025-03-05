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
      isArray: (name) => {return name === "outline"},
    });
    try {
      const object = parser.parse(opml);
      const mainOutline = object.opml?.body?.outline;

      if (!mainOutline) {
        return [];
      }

      return mainOutline.map((outline: Outline) => {
        return this.processOutline(outline);
      });
    } catch (error) {
      logError("Error while parsing OPML:", error);
      throw error;
    }
  }

  processOutline(outline: Outline): OpmlFolder | OpmlSource {
    const title = outline["@_"]?.["title"] ?? outline["@_"]?.["text"] ?? "Unknown";
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

    let children: Array<OpmlFolder | OpmlSource> = [];
    if (outline.outline) {
      if (Array.isArray(outline.outline)) {
        children = outline.outline.map((child: Outline) => {return this.processOutline(child)});
      } else {
        children = [this.processOutline(outline.outline as Outline)];
      }
    }

    return {
      children,
      name: title,
      type: "folder",
    };
  }
}
