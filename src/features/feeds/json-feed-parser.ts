import { parseFeedDate } from "#features/feeds/feed-date.ts";
import type {
  FeedItemMedia,
  FeedMapperInput,
} from "#features/feeds/feed-mapper.ts";
import { asHtmlText } from "#features/feeds/plain-text.ts";

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

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

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

export function parseJsonFeed(
  text: string,
): FeedMapperInput & { websubHubUrl: string | undefined } {
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
        content:
          asString(item.content_html) ??
          asHtmlText(asString(item.content_text)),
        description: asHtmlText(asString(item.summary)),
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
