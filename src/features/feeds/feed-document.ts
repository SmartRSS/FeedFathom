import { parseFeed } from "@rowanmanning/feed-parser";
import { parseContactString } from "@rowanmanning/feed-parser/lib/utils/parse-contact-string.js";
import { Element } from "@rowanmanning/feed-parser/lib/xml/element.js";
import Schema from "typebox/schema";
import { decodeXml } from "#shared/util/decode-body.ts";
import {
  parseRepairingXml,
  rejectXmlEntityDeclarations,
} from "#features/feeds/xml.ts";
import {
  inCapScope,
  mentionsCapNamespace,
  readCapAlert,
} from "#features/feeds/cap-entry.ts";
import { parseFeedDate } from "#features/feeds/feed-date.ts";
import {
  type FeedMapperInput,
  parsedFeedSchema,
} from "#features/feeds/feed-mapper.ts";
import { parseJsonFeed } from "#features/feeds/json-feed-parser.ts";
import { parseMicroformatFeed } from "#features/feeds/microformat-feed-parser.ts";
import {
  asHtmlText,
  hasHtmlTag,
  stripHtmlTags,
} from "#features/feeds/plain-text.ts";

const parsedFeedCheck = Schema.Compile(parsedFeedSchema);
Object.defineProperty(Element.prototype, "textContentAsDate", {
  get(this: Element) {
    return parseFeedDate(this.textContent);
  },
});

type XmlElement = ReturnType<typeof parseFeed>["items"][number]["element"];

function authorsWithoutMarkup(element: XmlElement) {
  const raw = ["managingeditor", "author", "creator"]
    .flatMap((name) => element.findElementsWithName(name))
    .filter((author) =>
      author.children.every((child) => typeof child === "string"),
    )
    .map((author) => author.textContentNormalized);
  if (!raw.some(hasHtmlTag)) return undefined;
  return raw
    .map((text) => parseContactString(stripHtmlTags(text)))
    .filter((author) => author !== null);
}

const isMediaRss = (element: XmlElement) =>
  element.namespaceUri === "http://search.yahoo.com/mrss/" ||
  element.namespaceUri === "https://search.yahoo.com/mrss/";

const mediaDescription = (element: XmlElement) =>
  [element, ...element.findElementsWithName("group").filter(isMediaRss)]
    .flatMap((parent) => parent.findElementsWithName("description"))
    .find((child) => isMediaRss(child) && child.textContent.trim())
    ?.textContent;

export const parseXmlFeed = (text: string) => {
  rejectXmlEntityDeclarations(text);
  const feed = parseRepairingXml(text, parseFeed);
  const feedAuthors = authorsWithoutMarkup(feed.element);
  if (feedAuthors)
    Object.defineProperty(feed, "authors", { value: feedAuthors });
  for (const key of ["authors", "categories", "url"] as const) {
    Object.defineProperty(feed, key, { value: feed[key] });
  }
  for (const item of feed.items) {
    const authors = authorsWithoutMarkup(item.element);
    if (authors) Object.defineProperty(item, "authors", { value: authors });
  }
  for (const item of feed.items) {
    if (item.content !== null || item.description !== null) continue;
    const description = asHtmlText(mediaDescription(item.element));
    if (description)
      Object.defineProperty(item, "description", { value: description });
  }
  if (mentionsCapNamespace(text)) {
    for (const item of feed.items.filter(({ element }) =>
      inCapScope(element),
    )) {
      const language =
        item.element.getAttribute("xml:lang") ??
        item.categories
          .find(({ term }) => term.startsWith("language="))
          ?.term.slice("language=".length) ??
        "";
      const cap = readCapAlert(item.element);
      Object.assign(item, cap ? { cap, language } : { language });
    }
  }
  if (!parsedFeedCheck.Check(feed)) {
    throw new Error("Feed parser returned an invalid feed projection");
  }
  return feed;
};

const htmlDoctypePattern = /^\s*(?:<!doctype html|<html[\s>])/i;

const feedRootPattern = /^\s*(?:<\?xml[^>]*\?>\s*)?<(?:rss|feed|rdf:RDF)[\s>]/i;

export function feedFormat(
  text: string,
  contentType: string | null,
): "json" | "microformat" | "xml" {
  if (text.trimStart().startsWith("{")) return "json";
  if (feedRootPattern.test(text)) return "xml";
  if (
    (contentType?.toLowerCase().includes("html") ?? false) ||
    htmlDoctypePattern.test(text)
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
