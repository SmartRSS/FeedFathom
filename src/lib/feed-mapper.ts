type FeedMapperItem = {
  authors: readonly { name: string | null }[];
  content: string | null;
  description: string | null;
  id: string | null;
  published: Date | null;
  title: string | null;
  updated: Date | null;
  url: string | null;
};

type FeedMapperInput = {
  description: string | null;
  items: readonly FeedMapperItem[];
  title: string | null;
  url: string | null;
};

export type ArticlePayload = {
  author: string;
  content: string;
  guid: string;
  publishedAt: Date;
  sourceId: number;
  title: string;
  updatedAt: Date | null;
  url: string;
  // TEMPORARY: WebSub push verification, remove after confirming.
  debugFetchTrigger?: string | null;
};

type FeedPreviewArticle = {
  author: string;
  content: string;
  guid: string;
  publishedAt: Date;
  title: string;
  updatedAt?: Date | null;
  url: string;
};

export type FeedPreview = {
  articles: FeedPreviewArticle[];
  description: string | undefined;
  feedUrl: string;
  freshUntil?: number | null;
  link: string | undefined;
  title: string;
};

export type Source = {
  id: number;
  url: string;
};

const generateArticleGuid = (
  item: FeedMapperItem,
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
): string => {
  if (item.id) {
    return item.id;
  }

  if (item.url && item.title) {
    return `${item.url}_${item.title}`;
  }

  const hashInput = [
    item.content,
    item.description,
    item.title,
    parsedFeed.title,
    parsedFeed.url,
    sourceUrl,
  ]
    .filter(Boolean)
    .join("_");
  return Bun.hash(hashInput).toString(36);
};

const safeHttpUrl = (value: string, baseUrl: string): string => {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    try {
      url = new URL(value, baseUrl);
    } catch {
      return "";
    }
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
};

export const safeArticleUrl = (value: string, baseUrl: string): string =>
  value.startsWith("/article/") ? value : safeHttpUrl(value, baseUrl);

export const mapFeedItemToArticle = (
  item: FeedMapperItem,
  parsedFeed: FeedMapperInput,
  source: Source,
  rewriteLinksFunction: (content: string, baseUrl: string) => string,
  now = Date.now(),
): ArticlePayload => {
  return {
    author:
      item.authors[0]?.name ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
    content: rewriteLinksFunction(
      item.content ?? item.description ?? "",
      item.url ?? "",
    ),
    guid: generateArticleGuid(item, parsedFeed, source.url),
    publishedAt: new Date(item.published ?? now),
    sourceId: source.id,
    title: item.title ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
    updatedAt:
      item.updated || item.published
        ? new Date(item.updated ?? item.published ?? now)
        : null,
    url: safeHttpUrl(item.url ?? "", parsedFeed.url ?? source.url),
  };
};

export const mapFeedToPreview = (
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  rewriteLinksFunction: (content: string, baseUrl: string) => string,
  now = Date.now(),
): FeedPreview => {
  const source = { id: 0, url: sourceUrl };
  return {
    articles: parsedFeed.items.map((item) => {
      const article = mapFeedItemToArticle(
        item,
        parsedFeed,
        source,
        rewriteLinksFunction,
        now,
      );
      return {
        author: article.author,
        content: article.content,
        guid: article.guid,
        publishedAt: article.publishedAt,
        title: article.title,
        updatedAt: article.updatedAt,
        url: safeHttpUrl(article.url, parsedFeed.url ?? sourceUrl),
      };
    }),
    description: parsedFeed.description ?? undefined,
    feedUrl: sourceUrl,
    link: safeHttpUrl(parsedFeed.url ?? "", sourceUrl) || undefined,
    title: parsedFeed.title ?? parsedFeed.url ?? sourceUrl,
  };
};
