import { decodeXml } from "#shared/util/decode-body.ts";
import {
  parseRepairingXml,
  rejectXmlEntityDeclarations,
} from "#features/feeds/xml.ts";
import type { FeedMapperInput } from "#features/feeds/feed-mapper.ts";
import { parseJsonFeed } from "#features/feeds/json-feed-parser.ts";
import { parseMicroformatFeed } from "#features/feeds/microformat-feed-parser.ts";
import {
  type ParsedXmlFeed,
  parseXmlFeedTree,
} from "#features/feeds/xml-feed-parser.ts";

export const parseXmlFeed = (text: string): ParsedXmlFeed => {
  rejectXmlEntityDeclarations(text);
  return parseRepairingXml(text, parseXmlFeedTree);
};

const htmlDoctypePattern = /^\s*(?:<!doctype html|<html[\s>])/i;

const feedRootPattern = /^\s*(?:<\?xml[^>]*\?>\s*)?<(?:rss|feed|rdf:RDF)[\s>]/i;

export function feedFormat(
  text: string,
  contentType: string | null,
): "json" | "microformat" | "xml" {
  const head = text.slice(0, 512);
  if (head.trimStart().startsWith("{")) return "json";
  if (feedRootPattern.test(head)) return "xml";
  if (
    (contentType?.toLowerCase().includes("html") ?? false) ||
    htmlDoctypePattern.test(head)
  )
    return "microformat";
  return "xml";
}

export function parseFeedDocument(
  body: ArrayBuffer,
  contentType: string | null,
  url: string,
): { feed: FeedMapperInput; text: string; websubHubUrl?: string } {
  const text = decodeXml(new Uint8Array(body), contentType);
  const format = feedFormat(text, contentType);
  if (format === "json") {
    const { websubHubUrl, ...feed } = parseJsonFeed(text);
    return websubHubUrl === undefined
      ? { feed, text }
      : { feed, text, websubHubUrl };
  }
  if (format === "microformat")
    return { feed: parseMicroformatFeed(text, url), text };
  return { feed: parseXmlFeed(text), text };
}
