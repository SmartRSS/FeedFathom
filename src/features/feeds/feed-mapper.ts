import { type Static, type TObjectOptions, type TSchema, Type } from "typebox";
import type { Enclosure } from "#shared/contracts/responses.ts";
import { dateType } from "#shared/validation/typebox-policy.ts";
import { safeHttpUrl } from "#shared/util/safe-url.ts";
import {
  capAlertSchema,
  isCapAlertCurrent,
  renderCapAlert,
} from "#features/feeds/cap-entry.ts";
import { stripHtmlTags } from "#features/feeds/plain-text.ts";

const nullableString = Type.Union([Type.String(), Type.Null()]);

const parsedFeedSchemaWith = <Time extends TSchema>(
  time: Time,
  options: TObjectOptions,
) =>
  Type.Object(
    {
      description: nullableString,
      items: Type.Array(
        Type.Object(
          {
            authors: Type.Array(Type.Object({ name: nullableString }, options)),
            cap: Type.Optional(capAlertSchema),
            content: nullableString,
            description: nullableString,
            id: nullableString,
            language: Type.Optional(Type.String()),
            media: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    image: nullableString,
                    mimeType: nullableString,
                    title: nullableString,
                    type: nullableString,
                    url: Type.String(),
                  },
                  options,
                ),
              ),
            ),
            published: Type.Union([time, Type.Null()]),
            title: nullableString,
            updated: Type.Union([time, Type.Null()]),
            url: nullableString,
          },
          options,
        ),
      ),
      title: nullableString,
      url: nullableString,
    },
    options,
  );

export const parsedFeedSchema = parsedFeedSchemaWith(dateType, {
  additionalProperties: true,
});
export const parsedFeedWireSchema = parsedFeedSchemaWith(Type.Number(), {
  additionalProperties: false,
});

export type FeedMapperInput = Static<typeof parsedFeedSchema>;
export type FeedMapperItem = FeedMapperInput["items"][number];
export type FeedItemMedia = NonNullable<FeedMapperItem["media"]>[number];

export type FeedArticle = {
  author: string;
  content: string;
  contentBaseUrl?: string;
  enclosures: Enclosure[];
  expiresAt?: number;
  guid: string;
  publishedAt: Date;
  title: string;
  updatedAt: Date | null;
  url: string;
};

export type FeedPreview = {
  articles: FeedArticle[];
  description: string | undefined;
  feedUrl: string;
  freshUntil?: number | null;
  link: string | undefined;
  title: string;
  truncated?: boolean;
  feed?: FeedMapperInput;
  finalUrl?: string;
};

type MapOptions = { baseUrl?: string | undefined; now?: number };

const baseArticleGuid = (
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

const generateArticleGuid = (
  item: FeedMapperItem,
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
): string => {
  const guid = baseArticleGuid(item, parsedFeed, sourceUrl);
  if (item.language === undefined) return guid;
  const entry = Bun.hash([item.language, item.url, item.title].join("\n"));
  return `${guid}#${entry.toString(36)}`;
};

export const feedHomeUrl = (
  parsedFeed: FeedMapperInput,
  baseUrl: string,
): string | undefined =>
  safeHttpUrl(parsedFeed.url ?? "", baseUrl) || undefined;

const itemBody = (item: FeedMapperItem): string =>
  (item.cap ? renderCapAlert(item.cap) : "") +
  (item.content ?? item.description ?? "");

const maxEnclosures = 20;
const isPlayableMedium = (
  value: null | string,
): value is "audio" | "image" | "video" =>
  value === "audio" || value === "image" || value === "video";

const mapEnclosures = (
  items: readonly FeedItemMedia[],
  baseUrl: string,
): Enclosure[] => {
  if (items.length === 0) return [];
  const enclosures: Enclosure[] = [];
  for (const item of items) {
    const url = safeHttpUrl(item.url, baseUrl);
    if (!url) continue;
    enclosures.push({
      medium: isPlayableMedium(item.type) ? item.type : "other",
      mimeType: item.mimeType,
      thumbnail: safeHttpUrl(item.image ?? "", baseUrl) || null,
      title: item.title,
      url,
    });
    if (enclosures.length === maxEnclosures) break;
  }
  return enclosures;
};

const resolveFeedHomepage = (
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  baseUrl: string,
): string => {
  const fallbackBase = safeHttpUrl(baseUrl, sourceUrl) || sourceUrl;
  return safeHttpUrl(parsedFeed.url ?? "", fallbackBase) || fallbackBase;
};

const mapFeedItem = (
  item: FeedMapperItem,
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  homepage: string,
  fallbackLabel: string,
  now: number,
  precomputedBody?: string,
): FeedArticle => {
  const url = safeHttpUrl(item.url ?? "", homepage);
  const linkBase = url || homepage;
  const rawAuthor = item.authors[0]?.name;
  const authorName = rawAuthor ? stripHtmlTags(rawAuthor) || null : null;
  const expiresAt = item.cap ? Date.parse(item.cap.expires) : Number.NaN;
  const published = item.published;
  const updated = item.updated;
  const effectiveUpdated = updated ?? published;
  const article: FeedArticle = {
    author: authorName ?? fallbackLabel,
    content: precomputedBody ?? itemBody(item),
    contentBaseUrl: linkBase,
    enclosures: item.media ? mapEnclosures(item.media, linkBase) : [],
    guid: generateArticleGuid(item, parsedFeed, sourceUrl),
    publishedAt: new Date(published ?? updated ?? now),
    title: item.title ?? fallbackLabel,
    updatedAt: effectiveUpdated ? new Date(effectiveUpdated) : null,
    url,
  };
  if (!Number.isNaN(expiresAt)) article.expiresAt = expiresAt;
  return article;
};

export const mapFeedItemToArticle = (
  item: FeedMapperItem,
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  { baseUrl = sourceUrl, now = Date.now() }: MapOptions = {},
): FeedArticle =>
  mapFeedItem(
    item,
    parsedFeed,
    sourceUrl,
    resolveFeedHomepage(parsedFeed, sourceUrl, baseUrl),
    parsedFeed.title ?? parsedFeed.url ?? sourceUrl,
    now,
  );

export const previewArticleLimit = 50;
export const previewContentBytesLimit = 512 * 1024;

export const mapFeedToArticles = (
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  {
    baseUrl = sourceUrl,
    items = parsedFeed.items,
    now = Date.now(),
  }: MapOptions & { items?: readonly FeedMapperItem[] } = {},
): FeedArticle[] => {
  const homepage = resolveFeedHomepage(parsedFeed, sourceUrl, baseUrl);
  const fallbackLabel = parsedFeed.title ?? parsedFeed.url ?? sourceUrl;
  const articles: FeedArticle[] = [];
  for (const item of items) {
    if (item.cap !== undefined && !isCapAlertCurrent(item.cap, now)) continue;
    articles.push(
      mapFeedItem(item, parsedFeed, sourceUrl, homepage, fallbackLabel, now),
    );
  }
  return articles;
};

export const mapFeedToPreview = (
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  { baseUrl = sourceUrl, now = Date.now() }: MapOptions = {},
): FeedPreview => {
  const homepage = resolveFeedHomepage(parsedFeed, sourceUrl, baseUrl);
  const fallbackLabel = parsedFeed.title ?? parsedFeed.url ?? sourceUrl;
  const articles: FeedArticle[] = [];
  let bytes = 0;
  let truncated = false;
  for (const item of parsedFeed.items) {
    if (item.cap !== undefined && !isCapAlertCurrent(item.cap, now)) continue;
    if (articles.length === previewArticleLimit) {
      truncated = true;
      break;
    }
    const body = itemBody(item);
    bytes += Buffer.byteLength(body);
    if (articles.length > 0 && bytes > previewContentBytesLimit) {
      truncated = true;
      break;
    }
    articles.push(
      mapFeedItem(
        item,
        parsedFeed,
        sourceUrl,
        homepage,
        fallbackLabel,
        now,
        body,
      ),
    );
  }
  const preview: FeedPreview = {
    articles,
    description: parsedFeed.description ?? undefined,
    feedUrl: sourceUrl,
    link: feedHomeUrl(parsedFeed, baseUrl),
    title: fallbackLabel,
    truncated,
  };
  if (truncated) {
    preview.feed = parsedFeed;
    preview.finalUrl = baseUrl;
  }
  return preview;
};
