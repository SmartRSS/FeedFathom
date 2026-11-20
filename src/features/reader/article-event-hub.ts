import {
  type ArticleEvent,
  articleEventsChannel,
  parseArticleEvent,
} from "#features/feeds/article-events.ts";

export type ArticleEventSubscriber = {
  on(
    event: "message",
    listener: (channel: string, message: string) => void,
  ): unknown;
  disconnect(): void;
  subscribe(channel: string): Promise<unknown>;
};

type Listener = { onClose: () => void; onEvent: (event: ArticleEvent) => void };

export class ArticleEventHub {
  private closed = false;
  private readonly listeners = new Set<Listener>();
  private subscriber: ArticleEventSubscriber | undefined;

  constructor(private readonly connect: () => ArticleEventSubscriber) {}

  public listen(listener: Listener): () => void {
    if (this.closed) {
      queueMicrotask(listener.onClose);
      return () => {};
    }
    this.listeners.add(listener);
    this.subscriber ??= this.start();
    return () => {
      this.listeners.delete(listener);
    };
  }

  public close(): void {
    this.closed = true;
    for (const listener of this.listeners) listener.onClose();
    this.listeners.clear();
    this.subscriber?.disconnect();
    this.subscriber = undefined;
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
