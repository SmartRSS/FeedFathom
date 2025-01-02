import xml2js from "xml2js";
import type { OpmlFolder, OpmlSource, Outline } from "../types/opml-types";
import { err } from "../util/log";

export class OpmlParser {
  async parseOpml(opml: string): Promise<(OpmlFolder | OpmlSource)[]> {
    const parser = new xml2js.Parser();
    try {
      const object = await parser.parseStringPromise(opml);
      return object.opml.body[0].outline.map((outline: Outline) =>
        this.processOutline(outline),
      );
    } catch (error) {
      err("Error while parsing OPML:", error);
      throw error;
    }
  }

  processOutline(outline: Outline): OpmlFolder | OpmlSource {
    const type = outline.$["type"] ?? "";
    const xmlUrl = outline.$["xmlUrl"] ?? "";
    const title = outline.$["title"] ?? outline.$["text"] ?? "Untitled";
    const homeUrl = outline.$["htmlUrl"] ?? "";

    if (["rss", "atom", "rdf", "jsonfeed"].includes(type) || xmlUrl) {
      return {
        type: "source",
        xmlUrl: xmlUrl ?? "",
        name: title,
        homeUrl: (() => {
          if (homeUrl) {
            return homeUrl;
          }
          if (xmlUrl) {
            try {
              return new URL(xmlUrl).origin;
            } catch (error) {
              err("Error parsing URL:", error);
              return "";
            }
          }
          return "";
        })(),
      };
    }

    const children =
      outline.outline?.map((child) => this.processOutline(child)) ?? [];
    return {
      type: "folder",
      name: title,
      children,
    };
  }
}
