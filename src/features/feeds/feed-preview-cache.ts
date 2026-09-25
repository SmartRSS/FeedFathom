import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import type {
  FeedMapperInput,
  FeedPreview,
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
    guid: Type.String(),
    publishedAt: Type.Number(),
    title: Type.String(),
    updatedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    url: Type.String(),
  },
  exact,
);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableTime = Type.Union([Type.Number(), Type.Null()]);
// Only the fields mapFeedItemToArticle reads, so subscribe can map the full
// feed later. The feed parser caps a body at 24 MiB, which bounds this too.
const feedWireSchema = Type.Object(
  {
    description: nullableString,
    items: Type.Array(
      Type.Object(
        {
          authors: Type.Array(Type.Object({ name: nullableString }, exact)),
          content: nullableString,
          description: nullableString,
          id: nullableString,
          published: nullableTime,
          title: nullableString,
          updated: nullableTime,
          url: nullableString,
        },
        exact,
      ),
    ),
    title: nullableString,
    url: nullableString,
  },
  exact,
);
const previewWireSchema = Type.Object(
  {
    articles: Type.Array(previewArticleWireSchema),
    description: Type.Optional(Type.String()),
    feed: Type.Optional(feedWireSchema),
    feedUrl: Type.String(),
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

const decodeFeed = (value: Static<typeof feedWireSchema>): FeedMapperInput => ({
  ...value,
  items: value.items.map((item) => ({
    ...item,
    published: dateOrNull(item.published),
    updated: dateOrNull(item.updated),
  })),
});

// Projects the parsed feed field by field: the feed parser's items expose
// their fields through prototype getters, which JSON.stringify skips.
const encodeFeed = (feed: FeedMapperInput): Static<typeof feedWireSchema> => ({
  description: feed.description,
  items: feed.items.map((item) => ({
    authors: item.authors.map((author) => ({ name: author.name })),
    content: item.content,
    description: item.description,
    id: item.id,
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
  // A cache key collision (or a hand-edited Redis entry) must not hand back
  // another feed's preview under this URL.
  if (value.feedUrl !== expectedUrl) return undefined;

  return Object.assign(
    {
      articles: value.articles.map((article) =>
        Object.assign(
          {},
          article,
          { publishedAt: new Date(article.publishedAt) },
          article.updatedAt === undefined
            ? {}
            : {
                updatedAt:
                  article.updatedAt === null
                    ? null
                    : new Date(article.updatedAt),
              },
        ),
      ),
      description: value.description,
      feedUrl: value.feedUrl,
      link: value.link,
      title: value.title,
    },
    value.freshUntil === undefined ? {} : { freshUntil: value.freshUntil },
    value.truncated === undefined ? {} : { truncated: value.truncated },
    value.feed === undefined ? {} : { feed: decodeFeed(value.feed) },
  );
};

export const serializeFeedPreview = ({
  feed,
  ...preview
}: FeedPreview): string =>
  JSON.stringify({
    ...preview,
    ...(feed === undefined ? {} : { feed: encodeFeed(feed) }),
    articles: preview.articles.map((article) =>
      Object.assign(
        {},
        article,
        { publishedAt: article.publishedAt.getTime() },
        article.updatedAt === undefined
          ? {}
          : { updatedAt: article.updatedAt?.getTime() ?? null },
      ),
    ),
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
    } catch {
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
    } catch {}
  }

  private key(userId: number, feedUrl: string): string {
    const hash = createHash("sha256").update(feedUrl).digest("hex");
    return `feed-preview:${userId}:${hash}`;
  }
}
