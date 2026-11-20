import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import { enclosureSchema } from "#shared/contracts/responses.ts";
import {
  type FeedMapperInput,
  type FeedPreview,
  parsedFeedWireSchema,
} from "#features/feeds/feed-mapper.ts";

type PreviewCacheRedis = {
  del(key: string): Promise<number>;
  get(key: string): Promise<null | string>;
  set(
    key: string,
    value: string,
    expiration: "PX",
    milliseconds: number,
  ): Promise<unknown>;
};

const ttlMs = 10 * 60_000;

const exact = { additionalProperties: false } as const;
const previewArticleWireSchema = Type.Object(
  {
    author: Type.String(),
    content: Type.String(),
    enclosures: Type.Optional(Type.Array(enclosureSchema)),
    expiresAt: Type.Optional(Type.Number()),
    guid: Type.String(),
    publishedAt: Type.Number(),
    title: Type.String(),
    updatedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    url: Type.String(),
  },
  exact,
);
const previewWireSchema = Type.Object(
  {
    articles: Type.Array(previewArticleWireSchema),
    description: Type.Optional(Type.String()),
    feed: Type.Optional(parsedFeedWireSchema),
    feedUrl: Type.String(),
    finalUrl: Type.Optional(Type.String()),
    freshUntil: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    link: Type.Optional(Type.String()),
    title: Type.String(),
    truncated: Type.Optional(Type.Boolean()),
  },
  exact,
);
const previewWireCheck = Schema.Compile(previewWireSchema);

const dateOrNull = (time: null | number) =>
  time === null ? null : new Date(time);

const decodeFeed = (
  value: Static<typeof parsedFeedWireSchema>,
): FeedMapperInput => ({
  ...value,
  items: value.items.map((item) => ({
    ...item,
    published: dateOrNull(item.published),
    updated: dateOrNull(item.updated),
  })),
});

const encodeFeed = (
  feed: FeedMapperInput,
): Static<typeof parsedFeedWireSchema> => ({
  description: feed.description,
  items: feed.items.map((item) => ({
    authors: item.authors.map((author) => ({ name: author.name })),
    ...(item.cap === undefined ? {} : { cap: item.cap }),
    content: item.content,
    description: item.description,
    id: item.id,
    ...(item.language === undefined ? {} : { language: item.language }),
    ...(item.media === undefined
      ? {}
      : {
          media: item.media.map((media) => ({
            image: media.image,
            mimeType: media.mimeType,
            title: media.title,
            type: media.type,
            url: media.url,
          })),
        }),
    published: item.published?.getTime() ?? null,
    title: item.title,
    updated: item.updated?.getTime() ?? null,
    url: item.url,
  })),
  title: feed.title,
  url: feed.url,
});

const decodePreview = (
  value: unknown,
  expectedUrl: string,
): FeedPreview | undefined => {
  if (!previewWireCheck.Check(value)) return undefined;
  if (value.feedUrl !== expectedUrl) return undefined;

  return {
    articles: value.articles.map(
      ({ enclosures = [], publishedAt, updatedAt, ...article }) => ({
        ...article,
        enclosures,
        publishedAt: new Date(publishedAt),
        updatedAt: dateOrNull(
          updatedAt === undefined ? publishedAt : updatedAt,
        ),
      }),
    ),
    description: value.description,
    feedUrl: value.feedUrl,
    link: value.link,
    title: value.title,
    ...(value.freshUntil === undefined ? {} : { freshUntil: value.freshUntil }),
    ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
    ...(value.feed === undefined ? {} : { feed: decodeFeed(value.feed) }),
    ...(value.finalUrl === undefined ? {} : { finalUrl: value.finalUrl }),
  };
};

export const serializeFeedPreview = ({
  feed,
  ...preview
}: FeedPreview): string =>
  JSON.stringify({
    ...preview,
    ...(feed === undefined ? {} : { feed: encodeFeed(feed) }),
    articles: preview.articles.map((article) => ({
      ...article,
      publishedAt: article.publishedAt.getTime(),
      updatedAt: article.updatedAt?.getTime() ?? null,
    })),
  });

export const deserializeFeedPreview = (
  value: string,
  expectedUrl: string,
): FeedPreview | undefined => {
  try {
    const parsed: unknown = JSON.parse(value);
    return decodePreview(parsed, expectedUrl);
  } catch {
    return undefined;
  }
};

export class FeedPreviewCache {
  constructor(private readonly redis: PreviewCacheRedis) {}

  async get(userId: number, feedUrl: string): Promise<FeedPreview | undefined> {
    const key = this.key(userId, feedUrl);
    try {
      const cached = await this.redis.get(key);
      if (!cached) return undefined;

      const preview = deserializeFeedPreview(cached, feedUrl);
      if (!preview) await this.redis.del(key);
      return preview;
    } catch (error_: unknown) {
      console.error(`Failed to read feed preview for ${feedUrl}:`, error_);
      return undefined;
    }
  }

  async save(
    userId: number,
    feedUrl: string,
    preview: FeedPreview,
  ): Promise<void> {
    try {
      await this.redis.set(
        this.key(userId, feedUrl),
        serializeFeedPreview(preview),
        "PX",
        ttlMs,
      );
    } catch (error_: unknown) {
      console.error(`Failed to store feed preview for ${feedUrl}:`, error_);
    }
  }

  private key(userId: number, feedUrl: string): string {
    const hash = createHash("sha256").update(feedUrl).digest("hex");
    return `feed-preview:${userId}:${hash}`;
  }
}
