



import { type OpmlFolder, type OpmlSource, type Outline } from "../types/opml-types";
import { logError as error_ } from "../util/log";
import xml2js from "xml2js";

export class OpmlParser {
  async parseOpml(opml: string): Promise<Array<OpmlFolder | OpmlSource>> {
    const parser = new xml2js.Parser();
    try {
      const object = await parser.parseStringPromise(opml);
      return object.opml.body[0].outline.map((outline: Outline) =>
        {return this.processOutline(outline)},
      );
    } catch (error) {
      error_("Error while parsing OPML:", error);
      throw error;
    }
  }

  processOutline(outline: Outline): OpmlFolder | OpmlSource {
    const type = outline.$["type"] ?? "";
    const xmlUrl = outline.$["xmlUrl"] ?? "";
    const title = outline.$["title"] ?? outline.$["text"] ?? "Untitled";
    const homeUrl = outline.$["htmlUrl"] ?? "";

    if (["atom", "jsonfeed", "rdf", "rss"].includes(type) || xmlUrl) {
      return {
        homeUrl: (() => {
          if (homeUrl) {
            return homeUrl;
          }

          if (xmlUrl) {
            try {
              return new URL(xmlUrl).origin;
            } catch (error) {
              error_("Error parsing URL:", error);
              return "";
            }
          }

          return "";
        })(),
        name: title,
        type: "source",
        xmlUrl,
      };
    }

    const children =
      outline.outline?.map((child) => {return this.processOutline(child)}) ?? [];
    return {
      children,
      name: title,
      type: "folder",
    };
  }
}
