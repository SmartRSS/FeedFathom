import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";

// Every outbound fetch the server makes for a user goes through httpClient,
// which is polite per host but has no notion of "per user" -- nothing stops
// one account from directing it at thousands of hosts, and registration is
// open, so anyone can sign up and use FeedFathom as a free crawler from our
// IP. find, preview and subscribe are the three routes that trigger an
// outbound fetch on a user's say-so, so they share one allowance.
//
// Same fixed-window INCR+EXPIRE-in-one-script shape as AuthThrottle: the
// window is set once, on the counter's first hit, so the whole count expires
// together and costs one key per window rather than one per request.
const windowSeconds = 60;
const requestLimit = 30;

const countScript = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;

type BudgetRedis = {
  send(command: "EVAL", args: string[]): Promise<unknown>;
};

export class OutboundFetchBudget {
  constructor(private readonly redis: BudgetRedis) {}

  // Throws HttpDeferredError once the caller is over budget for the current
  // window, with retryAt taken from the counter's own remaining TTL so the
  // client is told exactly when the window turns over.
  public async consume(userId: number): Promise<void> {
    const result = await this.redis.send("EVAL", [
      countScript,
      "1",
      `outbound-fetch:${userId}`,
      windowSeconds.toString(),
    ]);
    const [count, ttl]: unknown[] = Array.isArray(result) ? result : [];
    if (Number(count ?? 0) > requestLimit) {
      throw new HttpDeferredError(
        Date.now() + Number(ttl ?? windowSeconds) * 1000,
      );
    }
  }
}
