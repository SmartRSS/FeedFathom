import type { RedisClient } from "bun";

// Redis pub/sub channel the worker announces article writes on, and the
// server's /api/events stream listens to (ADR 0007). Pub/sub keeps no
// backlog: a message published while no server listens is gone, which is
// fine because the SPA's timer poll still covers anything a signal missed.
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

  /**
   * Announces that `count` articles a subscriber's unread badge could see
   * changed for a source. Call it after the unread recount, so a client that
   * reloads on the signal reads the new counts. Never throws: the signal is
   * a latency optimisation and must not fail the write it announces.
   */
  public async publish(sourceId: number, count: number): Promise<void> {
    try {
      await this.redis.publish(
        articleEventsChannel,
        JSON.stringify({ count, sourceId } satisfies ArticleEvent),
      );
    } catch (error) {
      console.error("Publishing an article event failed:", error);
    }
  }
}
