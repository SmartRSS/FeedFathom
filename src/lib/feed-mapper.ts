import { type Feed } from "@rowanmanning/feed-parser/lib/feed/base";
import { type FeedItem } from "@rowanmanning/feed-parser/lib/feed/item/base";

export type ArticlePayload = {
  author: string;
  content: string;
  guid: string;
  publishedAt: Date;
  sourceId: number;
  title: string;
  updatedAt: Date;
  url: string;
};

export type FeedPreview = {
  description: string | undefined;
  feedUrl: string;
  link: string | undefined;
  title: string | undefined;
};

export type Source = {
  id: number;
  url: string;
};

const generateArticleGuid = (
  item: FeedItem,
  parsedFeed: Feed,
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
  item: FeedItem,
  parsedFeed: Feed,
  source: Source,
  rewriteLinksFunction: (content: string, baseUrl: string) => string,
): ArticlePayload => {
  return {
    author:
      item.authors[0]?.name ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
    content: rewriteLinksFunction(
      item.content ?? item.description ?? "",
      item.url ?? "",
    ),
    guid: generateArticleGuid(item, parsedFeed, source.url),
    publishedAt: new Date(item.published ?? Date.now()),
    sourceId: source.id,
    title: item.title ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
    updatedAt: new Date(item.updated ?? item.published ?? Date.now()),
    url: item.url ?? "",
  };
};

export const mapFeedToPreview = (
  parsedFeed: Feed,
  sourceUrl: string,
): FeedPreview => {
  return {
    description: parsedFeed.description ?? undefined,
    feedUrl: sourceUrl,
    link: parsedFeed.url ?? undefined,
    title: parsedFeed.title ?? undefined,
  };
};
