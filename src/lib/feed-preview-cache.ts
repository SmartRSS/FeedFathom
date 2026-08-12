import { createHash } from "node:crypto";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { Value } from "typebox/value";
import type { FeedPreview } from "./feed-mapper.ts";

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
const previewWireSchema = Type.Object(
  {
    articles: Type.Array(previewArticleWireSchema),
    description: Type.Optional(Type.String()),
    feedUrl: Type.String(),
    freshUntil: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    link: Type.Optional(Type.String()),
    title: Type.String(),
  },
  exact,
);
const previewWireCheck = Schema.Compile(previewWireSchema);

const decodePreview = (
  value: unknown,
  expectedUrl: string,
): FeedPreview | undefined => {
  if (!previewWireCheck.Check(value)) return undefined;

  const expectedFeedPolicy = Type.Object({
    feedUrl: Type.Literal(expectedUrl),
  });
  if (!Value.Check(expectedFeedPolicy, value)) return undefined;

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
  );
};

export const serializeFeedPreview = (preview: FeedPreview): string =>
  JSON.stringify({
    ...preview,
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
