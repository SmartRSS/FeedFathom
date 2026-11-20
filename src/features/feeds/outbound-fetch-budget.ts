import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import {
  countInWindow,
  type CounterRedis,
} from "#platform/redis-window-counter.ts";

const windowSeconds = 60;
const requestLimit = 30;

export class OutboundFetchBudget {
  constructor(private readonly redis: CounterRedis) {}

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
