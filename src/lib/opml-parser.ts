import { type } from "arktype";
import { XMLParser } from "fast-xml-parser";
import type { OpmlFolder, OpmlSource } from "../types/opml-types.ts";
import { logError } from "../util/log.ts";

const outlineItem = type({
  "@_": {
    "title?": "string",
    "text?": "string",
    "type?": "string",
    "xmlUrl?": "string",
    "htmlUrl?": "string",
    "[string]": "string",
  },
  "[string]": "unknown",
});

const outlineFolder = type({
  "@_": {
    "title?": "string",
    "text?": "string",
  },
  "outline?": outlineItem.array(),
});
const outline = outlineItem.or(outlineFolder);

const outlineSchema = type({
  "@_": {
    "title?": "string",
    "text?": "string",
    "type?": "string",
    "xmlUrl?": "string",
    "htmlUrl?": "string",
    "[string]": "string",
  },
  "[string]": "unknown",
  "outline?": outline.array(),
});

type Outline = typeof outlineSchema.infer;

const opmlSchema = type({
  opml: {
    body: {
      outline: outlineSchema.array(),
    },
  },
});

export class OpmlParser {
  parseOpml(opml: string): Array<OpmlFolder | OpmlSource> {
    const parser = new XMLParser({
      allowBooleanAttributes: true,
      alwaysCreateTextNode: true,
      attributeNamePrefix: "",
      attributesGroupName: "@_",
      ignoreAttributes: false,
      isArray: (name) => {
        return name === "outline";
      },
    });
    try {
      const object = parser.parse(opml) as unknown;
      if (typeof object !== "object" || object === null) {
        return [];
      }

      const result = opmlSchema(object);
      if (result instanceof type.errors) {
        return [];
      }

      const mainOutline = result.opml.body.outline;

      return mainOutline.map((outline: Outline) => {
        return this.processOutline(outline);
      });
    } catch (error) {
      logError("Error while parsing OPML:", error);
      throw error;
    }
  }

  processOutline(outline: Outline): OpmlFolder | OpmlSource {
    const title = outline["@_"]["title"] ?? outline["@_"]["text"] ?? "Unknown";
    const type = outline["@_"]["type"] ?? "";
    const xmlUrl = outline["@_"]["xmlUrl"] ?? "";
    const homeUrl = outline["@_"]["htmlUrl"] ?? "";

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
        children = outline.outline.map((child: Outline) => {
          return this.processOutline(child);
        });
      } else {
        children = [this.processOutline(outline.outline)];
      }
    }

    return {
      children,
      name: title,
      type: "folder",
    };
  }
}
