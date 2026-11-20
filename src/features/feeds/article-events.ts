import type { RedisClient } from "bun";

export const articleEventsChannel = "feedfathom:article-events";

export type ArticleEvent = { count: number; sourceId: number };

export function parseArticleEvent(message: string): ArticleEvent | undefined {
  try {
    const value: unknown = JSON.parse(message);
    if (
      typeof value === "object" &&
      value !== null &&
      "sourceId" in value &&
      "count" in value &&
      Number.isSafeInteger(value.sourceId) &&
      Number.isSafeInteger(value.count)
    ) {
      return { count: Number(value.count), sourceId: Number(value.sourceId) };
    }
  } catch {}
  return undefined;
}

export class ArticleEventPublisher {
  constructor(private readonly redis: Pick<RedisClient, "publish">) {}

  public publish(sourceId: number, count: number): void {
    this.redis
      .publish(
        articleEventsChannel,
        JSON.stringify({ count, sourceId } satisfies ArticleEvent),
      )
      .catch((error: unknown) => {
        console.error("Publishing an article event failed:", error);
      });
  }
}
