import { type Static, type TObjectOptions, type TSchema, Type } from "typebox";
import type { Enclosure } from "#shared/contracts/responses.ts";
import { dateType } from "#shared/validation/typebox-policy.ts";
import { safeHttpUrl } from "#shared/util/safe-url.ts";
import { rewriteLinks } from "#features/feeds/rewrite-links.ts";
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
  now: number,
): FeedArticle => {
  const url = safeHttpUrl(item.url ?? "", homepage);
  const linkBase = url || homepage;
  const rawAuthor = item.authors[0]?.name;
  const authorName = rawAuthor ? stripHtmlTags(rawAuthor) || null : null;
  const expiresAt = item.cap ? Date.parse(item.cap.expires) : Number.NaN;
  const published = item.published;
  const updated = item.updated;
  const effectiveUpdated = updated ?? published;
  const fallbackLabel = parsedFeed.title ?? parsedFeed.url ?? sourceUrl;
  return {
    author: authorName ?? fallbackLabel,
    content: rewriteLinks(itemBody(item), linkBase),
    enclosures: item.media ? mapEnclosures(item.media, linkBase) : [],
    ...(Number.isNaN(expiresAt) ? {} : { expiresAt }),
    guid: generateArticleGuid(item, parsedFeed, sourceUrl),
    publishedAt: new Date(published ?? updated ?? now),
    title: item.title ?? fallbackLabel,
    updatedAt: effectiveUpdated ? new Date(effectiveUpdated) : null,
    url,
  };
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
    now,
  );

const currentFeedItems = (
  items: readonly FeedMapperItem[],
  now: number,
): FeedMapperItem[] =>
  items.filter(
    (item) => item.cap === undefined || isCapAlertCurrent(item.cap, now),
  );

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
    if (count > 0 && bytes > previewContentBytesLimit) break;
    count++;
  }
  return items.slice(0, count);
};

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
  const articles: FeedArticle[] = [];
  for (const item of items) {
    if (item.cap !== undefined && !isCapAlertCurrent(item.cap, now)) continue;
    articles.push(mapFeedItem(item, parsedFeed, sourceUrl, homepage, now));
  }
  return articles;
};

export const mapFeedToPreview = (
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  { baseUrl = sourceUrl, now = Date.now() }: MapOptions = {},
): FeedPreview => {
  const current = currentFeedItems(parsedFeed.items, now);
  const items = previewItems(current);
  const truncated = items.length < current.length;
  return Object.assign(
    {
      articles: mapFeedToArticles(parsedFeed, sourceUrl, {
        baseUrl,
        items,
        now,
      }),
      description: parsedFeed.description ?? undefined,
      feedUrl: sourceUrl,
      link: feedHomeUrl(parsedFeed, baseUrl),
      title: parsedFeed.title ?? parsedFeed.url ?? sourceUrl,
      truncated,
    },
    truncated ? { feed: parsedFeed, finalUrl: baseUrl } : {},
  );
};
