import {
  type ArticleEvent,
  articleEventsChannel,
  parseArticleEvent,
} from "#features/feeds/article-events.ts";

// The slice of an ioredis connection the hub uses. ioredis rather than Bun's
// client because it resubscribes on its own after a reconnect.
export type ArticleEventSubscriber = {
  on(
    event: "message",
    listener: (channel: string, message: string) => void,
  ): unknown;
  quit(): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
};

type Listener = { onClose: () => void; onEvent: (event: ArticleEvent) => void };

/**
 * One Redis subscriber per server process, fanned out in memory to every
 * open /api/events stream. The connection opens on the first listener, so a
 * process that never serves a stream never subscribes, and stays open until
 * close() -- a dashboard reconnecting would otherwise churn it. close() also
 * ends every open stream: the server's graceful stop waits for in-flight
 * responses, and a stream left open would hold shutdown until the kill.
 */
export class ArticleEventHub {
  private readonly listeners = new Set<Listener>();
  private subscriber: ArticleEventSubscriber | undefined;

  constructor(private readonly connect: () => ArticleEventSubscriber) {}

  public listen(listener: Listener): () => void {
    this.listeners.add(listener);
    this.subscriber ??= this.start();
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async close(): Promise<void> {
    for (const listener of this.listeners) listener.onClose();
    this.listeners.clear();
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    await subscriber?.quit();
  }

  private start(): ArticleEventSubscriber {
    const subscriber = this.connect();
    subscriber.on("message", (channel, message) => {
      if (channel !== articleEventsChannel) return;
      const event = parseArticleEvent(message);
      if (!event) return;
      for (const listener of this.listeners) {
        try {
          listener.onEvent(event);
        } catch (error) {
          console.error("An article event listener failed:", error);
        }
      }
    });
    subscriber.subscribe(articleEventsChannel).catch((error: unknown) => {
      console.error("Subscribing to article events failed:", error);
    });
    return subscriber;
  }
}
