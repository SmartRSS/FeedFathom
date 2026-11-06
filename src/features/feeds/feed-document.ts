import { parseFeed } from "@rowanmanning/feed-parser";
import { parseContactString } from "@rowanmanning/feed-parser/lib/utils/parse-contact-string.js";
import { Element } from "@rowanmanning/feed-parser/lib/xml/element.js";
import Schema from "typebox/schema";
import { decodeBody } from "#shared/util/decode-body.ts";
import { rejectXmlEntityDeclarations } from "#platform/xml.ts";
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
const xmlEncodingPattern = /<\?xml[^>]*\bencoding=["']([^"']+)["']/i;

export function decodeFeedBody(
  buffer: ArrayBuffer,
  contentType: string | null,
): string {
  return decodeBody(
    new Uint8Array(buffer),
    contentType,
    xmlEncodingPattern,
    200,
  );
}

// feed-parser reads every RSS and Atom date, on items and on the feed, through
// this one getter, which hands the text to a bare `new Date`. Replacing the
// getter routes them all through parseFeedDate; the date-zones fixtures fail
// if a feed-parser release stops reading dates through it.
Object.defineProperty(Element.prototype, "textContentAsDate", {
  get(this: Element) {
    return parseFeedDate(this.textContent);
  },
});

type XmlElement = ReturnType<typeof parseFeed>["items"][number]["element"];

// The library splits an RSS author or dc:creator as "Name <email>" and drops
// any word's outer angle brackets, so a name wrapped in markup (WordPress
// h-card plugins wrap dc:creator in a span) came out as
// "span class='p-author h-card'>Name</span". Where the raw text holds a tag,
// the tags are stripped before the same split, over the same elements the
// library reads. Undefined leaves the library's own reading in place, which
// is always the case for Atom: its <author> has child elements and is not
// split this way.
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

// Media RSS's description, on the entry or its media:group. It is plain text.
const mediaDescription = (element: XmlElement) =>
  [element, ...element.findElementsWithName("group").filter(isMediaRss)]
    .flatMap((parent) => parent.findElementsWithName("description"))
    .find((child) => isMediaRss(child) && child.textContent.trim())
    ?.textContent;

/**
 * Parses an RSS or Atom feed. Each entry in CAP namespace scope also gets its
 * alert fields, if any, as `cap`, and its `xml:lang`, else the
 * `language=en-CA` category NAAD uses, else "", as `language`; see
 * generateArticleGuid. An entry with no body of its own,
 * such as every YouTube video, takes its Media RSS description instead.
 *
 * The result is checked against the parsed-feed schema: the library is
 * untyped JavaScript, so its runtime shape is not something to trust.
 */
export const parseXmlFeed = (text: string) => {
  rejectXmlEntityDeclarations(text);
  const feed = parseFeed(text);
  const feedAuthors = authorsWithoutMarkup(feed.element);
  if (feedAuthors)
    Object.defineProperty(feed, "authors", { value: feedAuthors });
  // An item without its own url, authors or categories falls back to the
  // feed's, which the library recomputes on every read by wrapping each child
  // of the channel, items included. Pinned once, reading every item is linear
  // in the item count instead of quadratic (#1031).
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
    // The prototype's getter has no setter, so plain assignment would throw.
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

// Origins that serve a perfectly good RSS/Atom document as `text/html` are
// common enough to matter (WordPress behind a proxy that rewrites the header,
// static hosts that guess a type from the extension). Believing the header
// there hands XML to the microformats parser, which finds no h-entry items
// and fails the whole source. The document's own root element is the more
// reliable witness, so it wins. An XML declaration alone would not be: XHTML
// pages carrying microformats open with one too, which is why this looks past
// it for the root element rather than stopping at `<?xml`.
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

/**
 * A fetched feed document, whatever its format, as the parsed feed mapping
 * reads. `text` is the decoded body, which WebSub discovery scans, and
 * `websubHubUrl` the hub a JSON Feed names in its own `hubs` array.
 */
export function parseFeedDocument(
  body: ArrayBuffer,
  contentType: string | null,
  url: string,
): { feed: FeedMapperInput; text: string; websubHubUrl?: string } {
  const text = decodeFeedBody(body, contentType);
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
