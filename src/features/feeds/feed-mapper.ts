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

// The fields of a parsed feed that mapping reads, whichever parser produced
// it. `time` is how a date is held: a Date in memory, epoch milliseconds in
// the preview cache. An open schema accepts the XML library's objects, which
// carry more than this; the cache's closed one rejects anything else.
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
            // Set, possibly empty, on every entry of a CAP feed, and only there.
            language: Type.Optional(Type.String()),
            // feed-parser's enclosures and Media RSS content; `type` is the
            // medium attribute, else the MIME type's top level.
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
  // A CAP alert's expiry: an import after it must leave the alert out.
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
  // True when the feed held more articles than the preview bounds kept.
  truncated?: boolean;
  // The complete parsed feed behind a truncated preview. The preview cache
  // keeps it so subscribing imports every article without a refetch.
  feed?: FeedMapperInput;
  // Where the feed was fetched from after redirects. Kept with `feed`, whose
  // relative links resolve against it the way every poll resolves them.
  finalUrl?: string;
};

// `baseUrl` is where the feed was fetched from after redirects, the source
// URL by default; `now` dates an entry that carries no date of its own.
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

// NAAD lists each alert once per language and per CAP info block, all under
// one id, and the store keeps one article per guid. A CAP entry's guid
// therefore also hashes what tells those copies apart. It depends on the
// entry alone, so it survives its neighbours changing, and identical copies
// still collapse. Other feeds keep their guids unchanged.
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

// The site a feed says it belongs to, resolved against `baseUrl`.
export const feedHomeUrl = (
  parsedFeed: FeedMapperInput,
  baseUrl: string,
): string | undefined =>
  safeHttpUrl(parsedFeed.url ?? "", baseUrl) || undefined;

// The HTML an article body starts from, before its links are rewritten.
const itemBody = (item: FeedMapperItem): string =>
  (item.cap ? renderCapAlert(item.cap) : "") +
  (item.content ?? item.description ?? "");

// ponytail: a feed listing hundreds of media per item keeps the first 20.
const maxEnclosures = 20;
const isPlayableMedium = (
  value: null | string,
): value is "audio" | "image" | "video" =>
  value === "audio" || value === "image" || value === "video";

const mapEnclosures = (
  items: readonly FeedItemMedia[],
  baseUrl: string,
): Enclosure[] =>
  items
    .flatMap((item): Enclosure[] => {
      const url = safeHttpUrl(item.url, baseUrl);
      if (!url) return [];
      return [
        {
          medium: isPlayableMedium(item.type) ? item.type : "other",
          mimeType: item.mimeType,
          thumbnail: safeHttpUrl(item.image ?? "", baseUrl) || null,
          title: item.title,
          url,
        },
      ];
    })
    .slice(0, maxEnclosures);

export const mapFeedItemToArticle = (
  item: FeedMapperItem,
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  { baseUrl = sourceUrl, now = Date.now() }: MapOptions = {},
): FeedArticle => {
  // Content links resolve against the article, then the feed homepage, then
  // the feed itself, so relative feed URLs still land on the publisher.
  const fallbackBase = safeHttpUrl(baseUrl, sourceUrl) || sourceUrl;
  const homepage =
    safeHttpUrl(parsedFeed.url ?? "", fallbackBase) || fallbackBase;
  const url = safeHttpUrl(item.url ?? "", homepage);
  // A name that was nothing but markup falls back like a missing one.
  const authorName = stripHtmlTags(item.authors[0]?.name ?? "") || null;
  const expiresAt = Date.parse(item.cap?.expires ?? "");
  return {
    author: authorName ?? parsedFeed.title ?? parsedFeed.url ?? sourceUrl,
    content: rewriteLinks(itemBody(item), url || homepage),
    enclosures: mapEnclosures(item.media ?? [], url || homepage),
    ...(Number.isNaN(expiresAt) ? {} : { expiresAt }),
    guid: generateArticleGuid(item, parsedFeed, sourceUrl),
    publishedAt: new Date(item.published ?? item.updated ?? now),
    title: item.title ?? parsedFeed.title ?? parsedFeed.url ?? sourceUrl,
    updatedAt:
      item.updated || item.published
        ? new Date(item.updated ?? item.published ?? now)
        : null,
    url,
  };
};

// CAP feeds keep listing alerts that have expired, and may carry test ones.
const currentFeedItems = (
  items: readonly FeedMapperItem[],
  now: number,
): FeedMapperItem[] =>
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

// The feed's current articles, every one of them unless `items` narrows it.
export const mapFeedToArticles = (
  parsedFeed: FeedMapperInput,
  sourceUrl: string,
  {
    baseUrl,
    items = parsedFeed.items,
    now = Date.now(),
  }: MapOptions & { items?: readonly FeedMapperItem[] } = {},
): FeedArticle[] =>
  currentFeedItems(items, now).map((item) =>
    mapFeedItemToArticle(item, parsedFeed, sourceUrl, { baseUrl, now }),
  );

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
      link: feedHomeUrl(parsedFeed, sourceUrl),
      title: parsedFeed.title ?? parsedFeed.url ?? sourceUrl,
      truncated,
    },
    truncated ? { feed: parsedFeed, finalUrl: baseUrl } : {},
  );
};
