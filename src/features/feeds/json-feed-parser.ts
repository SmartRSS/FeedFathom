// JSON Feed (https://www.jsonfeed.org/, versions 1 and 1.1) is simple
// enough as a flat JSON object that a small hand-rolled mapper is less
// code than adding a dependency for it -- unlike RSS/Atom's actual XML
// grammar, there's no real parsing to do here, just field renaming.

import { parseFeedDate } from "#features/feeds/feed-date.ts";
import type { FeedItemMedia } from "#features/feeds/feed-mapper.ts";

type JsonFeedAuthor = { name?: unknown };
type JsonFeedAttachment = {
  mime_type?: unknown;
  title?: unknown;
  url?: unknown;
};
type JsonFeedItem = {
  attachments?: unknown;
  author?: JsonFeedAuthor;
  authors?: unknown;
  content_html?: unknown;
  content_text?: unknown;
  date_modified?: unknown;
  date_published?: unknown;
  id?: unknown;
  summary?: unknown;
  title?: unknown;
  url?: unknown;
};
type JsonFeedHub = { type?: unknown; url?: unknown };
type JsonFeedDocument = {
  authors?: unknown;
  description?: unknown;
  feed_url?: unknown;
  home_page_url?: unknown;
  hubs?: unknown;
  items?: unknown;
  title?: unknown;
};

export function isJsonFeedText(text: string): boolean {
  return text.trimStart().startsWith("{");
}

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

// content_text and summary are plain text, but articles carry HTML: escape
// them so literal markup and entities survive, and keep their line breaks.
export const asHtmlText = (value: unknown): string | null => {
  const text = asString(value);
  return text === null
    ? null
    : Bun.escapeHTML(text).replaceAll(/\r\n?|\n/gu, "<br>");
};

const asDate = (value: unknown): Date | null =>
  typeof value === "string" ? parseFeedDate(value) : null;

function itemAuthors(item: JsonFeedItem, feedAuthors: unknown) {
  const list = Array.isArray(item.authors)
    ? item.authors
    : item.author
      ? [item.author]
      : Array.isArray(feedAuthors)
        ? feedAuthors
        : [];
  return list.map((author: unknown) => ({
    name: asString(
      typeof author === "object" && author !== null
        ? (author as JsonFeedAuthor).name
        : undefined,
    ),
  }));
}

// JSON Feed names only a MIME type; its top level stands in for the medium,
// as feed-parser does for RSS enclosures.
function itemMedia(item: JsonFeedItem): FeedItemMedia[] {
  if (!Array.isArray(item.attachments)) return [];
  return item.attachments.flatMap((raw: unknown) => {
    const attachment = (raw ?? {}) as JsonFeedAttachment;
    const url = asString(attachment.url);
    if (!url) return [];
    const mimeType = asString(attachment.mime_type)?.toLowerCase() ?? null;
    return [
      {
        image: null,
        mimeType,
        title: asString(attachment.title),
        type: mimeType?.split("/")[0] ?? null,
        url,
      },
    ];
  });
}

// The `hubs` entry of type "WebSub", JSON Feed's counterpart of a hub link.
// A hubs array with any malformed entry names no hub at all.
function websubHubUrl(hubs: unknown): string | undefined {
  if (!Array.isArray(hubs)) return undefined;
  const entries = hubs.map((hub: unknown) => (hub ?? {}) as JsonFeedHub);
  if (
    !entries.every(
      (hub) => typeof hub.type === "string" && typeof hub.url === "string",
    )
  )
    return undefined;
  return (
    asString(entries.find((hub) => hub.type === "WebSub")?.url) ?? undefined
  );
}

export function parseJsonFeed(text: string) {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("The JSON document could not be parsed as a feed");
  }
  const feed = parsed as JsonFeedDocument;
  if (!Array.isArray(feed.items)) {
    throw new Error("The JSON document could not be parsed as a feed");
  }

  return {
    description: asString(feed.description),
    items: feed.items.map((rawItem: unknown) => {
      const item = (rawItem ?? {}) as JsonFeedItem;
      return {
        authors: itemAuthors(item, feed.authors),
        content: asString(item.content_html) ?? asHtmlText(item.content_text),
        description: asHtmlText(item.summary),
        id: asString(item.id),
        media: itemMedia(item),
        published: asDate(item.date_published),
        title: asString(item.title),
        updated: asDate(item.date_modified),
        url: asString(item.url),
      };
    }),
    title: asString(feed.title),
    url: asString(feed.home_page_url) ?? asString(feed.feed_url),
    websubHubUrl: websubHubUrl(feed.hubs),
  };
}
