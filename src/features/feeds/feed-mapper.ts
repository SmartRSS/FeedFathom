import { safeHttpUrl } from "#shared/util/safe-url.ts";
import {
  type CapAlert,
  isCapAlertCurrent,
  renderCapAlert,
} from "#features/feeds/cap-entry.ts";

type FeedMapperItem = {
  authors: readonly { name: string | null }[];
  cap?: CapAlert;
  content: string | null;
  description: string | null;
  id: string | null;
  language?: string;
  published: Date | null;
  title: string | null;
  updated: Date | null;
  url: string | null;
};

export type FeedMapperInput = {
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
  // A CAP alert's expiry: subscribing later must not import it once passed.
  expiresAt?: number;
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
  // The complete parsed feed behind a truncated preview. The preview cache
  // keeps it so subscribing imports every article without a refetch.
  feed?: FeedMapperInput;
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

// The HTML an article body starts from, before its links are rewritten.
const itemBody = (item: FeedMapperItem): string =>
  (item.cap ? renderCapAlert(item.cap) : "") +
  (item.content ?? item.description ?? "");

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
    content: rewriteLinksFunction(itemBody(item), url || homepage),
    guid: generateArticleGuid(item, parsedFeed, source.url),
    publishedAt: new Date(item.published ?? item.updated ?? now),
    sourceId: source.id,
    title: item.title ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
    updatedAt:
      item.updated || item.published
        ? new Date(item.updated ?? item.published ?? now)
        : null,
    url,
  };
};

// NAAD lists each alert once per language, and once per CAP info block, under
// one id. The store keeps one article per guid, so entries that share a guid
// within one fetch get their language appended and, where that still repeats,
// their occurrence number in feed order. A guid no other entry shares stays
// as it was, so already-stored articles keep matching.
export const mapFeedItemsToArticles = (
  items: readonly FeedMapperItem[],
  parsedFeed: FeedMapperInput,
  source: Source,
  rewriteLinksFunction: (content: string, baseUrl: string) => string,
  now = Date.now(),
): ArticlePayload[] => {
  const mapped = items.map((item) => ({
    article: mapFeedItemToArticle(
      item,
      parsedFeed,
      source,
      rewriteLinksFunction,
      now,
    ),
    language: item.language,
  }));
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { article } of mapped) {
    (seen.has(article.guid) ? shared : seen).add(article.guid);
  }
  const occurrences = new Map<string, number>();
  return mapped.map(({ article, language }) => {
    if (!shared.has(article.guid)) return article;
    const base = language ? `${article.guid}#${language}` : article.guid;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return Object.assign(article, {
      guid: occurrence === 1 ? base : `${base}#${occurrence}`,
    });
  });
};

// CAP feeds keep listing alerts that have expired, and may carry test ones.
export const currentFeedItems = <Item extends FeedMapperItem>(
  items: readonly Item[],
  now: number,
): Item[] =>
  items.filter(
    (item) => item.cap === undefined || isCapAlertCurrent(item.cap, now),
  );

// A preview is a sample for deciding whether to subscribe, and it runs on the
// API server's event loop. Bounding the items before rewriting keeps that work
// from scaling with the feed. Subscribing maps and imports the whole
// cached parsed feed, so these limits never drop stored articles.
export const previewArticleLimit = 50;
export const previewContentBytesLimit = 512 * 1024;

const previewItems = (
  items: readonly FeedMapperItem[],
): readonly FeedMapperItem[] => {
  let bytes = 0;
  let count = 0;
  for (const item of items) {
    if (count === previewArticleLimit) break;
    bytes += Buffer.byteLength(itemBody(item));
    // The first article always fits, so one oversized item still previews.
    if (count > 0 && bytes > previewContentBytesLimit) break;
    count++;
  }
  return items.slice(0, count);
};

export const mapFeedToPreviewArticles = (
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  rewriteLinksFunction: (content: string, baseUrl: string) => string,
  now = Date.now(),
  items = parsedFeed.items,
): FeedPreviewArticle[] => {
  const current = currentFeedItems(items, now);
  const articles = mapFeedItemsToArticles(
    current,
    parsedFeed,
    { id: 0, url: sourceUrl },
    rewriteLinksFunction,
    now,
  );
  return articles.map((article, index) => {
    const expiresAt = Date.parse(current[index]?.cap?.expires ?? "");
    return Object.assign(
      {
        author: article.author,
        content: article.content,
        guid: article.guid,
        publishedAt: article.publishedAt,
        title: article.title,
        updatedAt: article.updatedAt,
        url: article.url,
      },
      Number.isNaN(expiresAt) ? {} : { expiresAt },
    );
  });
};

export const mapFeedToPreview = (
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  rewriteLinksFunction: (content: string, baseUrl: string) => string,
  now = Date.now(),
): FeedPreview => {
  const current = currentFeedItems(parsedFeed.items, now);
  const items = previewItems(current);
  const truncated = items.length < current.length;
  return Object.assign(
    {
      articles: mapFeedToPreviewArticles(
        parsedFeed,
        sourceUrl,
        rewriteLinksFunction,
        now,
        items,
      ),
      description: parsedFeed.description ?? undefined,
      feedUrl: sourceUrl,
      link: safeHttpUrl(parsedFeed.url ?? "", sourceUrl) || undefined,
      title: parsedFeed.title ?? parsedFeed.url ?? sourceUrl,
      truncated,
    },
    truncated ? { feed: parsedFeed } : {},
  );
};
