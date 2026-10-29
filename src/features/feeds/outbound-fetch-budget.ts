import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import {
  countInWindow,
  type CounterRedis,
} from "#platform/redis-window-counter.ts";

// Every outbound fetch the server makes for a user goes through httpClient,
// which is polite per host but has no notion of "per user" -- nothing stops
// one account from directing it at thousands of hosts, and registration is
// open, so anyone can sign up and use FeedFathom as a free crawler from our
// IP. find, preview and subscribe are the three routes that trigger an
// outbound fetch on a user's say-so, so they share one allowance.
const windowSeconds = 60;
const requestLimit = 30;

export class OutboundFetchBudget {
  constructor(private readonly redis: CounterRedis) {}

  // Throws HttpDeferredError once the caller is over budget for the current
  // window, with retryAt taken from the counter's own remaining TTL so the
  // client is told exactly when the window turns over.
  public async consume(userId: number): Promise<void> {
    const { count, ttl } = await countInWindow(
      this.redis,
      `outbound-fetch:${userId}`,
      windowSeconds,
    );
    if (count > requestLimit) {
      throw new HttpDeferredError(Date.now() + ttl * 1000);
    }
  }
}
