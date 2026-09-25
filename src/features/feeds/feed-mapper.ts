import { safeHttpUrl } from "#shared/util/safe-url.ts";

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
  // True when the feed held more articles than the preview bounds kept.
  truncated?: boolean;
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

export const mapFeedItemToArticle = (
  item: FeedMapperItem,
  parsedFeed: FeedMapperInput,
  source: Source,
  rewriteLinksFunction: (content: string, baseUrl: string) => string,
  now = Date.now(),
): ArticlePayload => {
  // Content links resolve against the article, then the feed homepage, then
  // the feed itself, so relative feed URLs still land on the publisher.
  const homepage = safeHttpUrl(parsedFeed.url ?? "", source.url) || source.url;
  const url = safeHttpUrl(item.url ?? "", homepage);
  return {
    author:
      item.authors[0]?.name ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
    content: rewriteLinksFunction(
      item.content ?? item.description ?? "",
      url || homepage,
    ),
    guid: generateArticleGuid(item, parsedFeed, source.url),
    publishedAt: new Date(item.published ?? now),
    sourceId: source.id,
    title: item.title ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
    updatedAt:
      item.updated || item.published
        ? new Date(item.updated ?? item.published ?? now)
        : null,
    url,
  };
};

// A preview is a sample for deciding whether to subscribe, and it runs on the
// API server's event loop. Bounding the items before rewriting keeps that work
// from scaling with the feed. Subscribing imports the whole feed through the
// worker, so these limits never drop stored articles.
export const previewArticleLimit = 50;
export const previewContentBytesLimit = 512 * 1024;

const previewItems = (
  items: readonly FeedMapperItem[],
): readonly FeedMapperItem[] => {
  let bytes = 0;
  let count = 0;
  for (const item of items) {
    if (count === previewArticleLimit) break;
    bytes += Buffer.byteLength(item.content ?? item.description ?? "");
    // The first article always fits, so one oversized item still previews.
    if (count > 0 && bytes > previewContentBytesLimit) break;
    count++;
  }
  return items.slice(0, count);
};

export const mapFeedToPreview = (
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  rewriteLinksFunction: (content: string, baseUrl: string) => string,
  now = Date.now(),
): FeedPreview => {
  const source = { id: 0, url: sourceUrl };
  const items = previewItems(parsedFeed.items);
  return {
    articles: items.map((item) => {
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
        url: article.url,
      };
    }),
    description: parsedFeed.description ?? undefined,
    feedUrl: sourceUrl,
    link: safeHttpUrl(parsedFeed.url ?? "", sourceUrl) || undefined,
    title: parsedFeed.title ?? parsedFeed.url ?? sourceUrl,
    truncated: items.length < parsedFeed.items.length,
  };
};
