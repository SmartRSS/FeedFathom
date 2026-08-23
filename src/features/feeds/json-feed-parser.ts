// JSON Feed (https://www.jsonfeed.org/, versions 1 and 1.1) is simple
// enough as a flat JSON object that a small hand-rolled mapper is less
// code than adding a dependency for it -- unlike RSS/Atom's actual XML
// grammar, there's no real parsing to do here, just field renaming.

type JsonFeedAuthor = { name?: unknown };
type JsonFeedItem = {
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
type JsonFeedDocument = {
  authors?: unknown;
  description?: unknown;
  feed_url?: unknown;
  home_page_url?: unknown;
  items?: unknown;
  title?: unknown;
};

export function isJsonFeedText(text: string): boolean {
  return text.trimStart().startsWith("{");
}

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asDate = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

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
        content: asString(item.content_html) ?? asString(item.content_text),
        description: asString(item.summary),
        id: asString(item.id),
        published: asDate(item.date_published),
        title: asString(item.title),
        updated: asDate(item.date_modified),
        url: asString(item.url),
      };
    }),
    title: asString(feed.title),
    url: asString(feed.home_page_url) ?? asString(feed.feed_url),
  };
}
