import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import type { RequestDeadline } from "#platform/http/request-deadline.ts";

// Politeness and back-pressure toward one origin: how long this instance
// waits between requests to a host, how an interactive request jumps ahead of
// a background one, and how long a rate-limited host stays blocked.

const blockedPrefix = "http-blocked:";
const intervalPrefix = "http-interval:";
const interactivePrefix = "http-interactive:";
const feedDelayMs = 10_000;
const interactiveWaitMs = 2_500;
const fallbackBlockMs = 5 * 60_000;

type RateLimitRedis = {
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<null | string>;
  incr(key: string): Promise<number>;
  set(
    key: string,
    value: string,
    ...options: Array<number | string>
  ): Promise<null | string>;
};

/**
 * When a blocked host may be tried again.
 *
 * Retry-After is whatever the origin chose to send: a delta in seconds, an
 * HTTP date, or nonsense. Anything unusable falls back to five minutes rather
 * than to "right now", so a malformed header cannot turn a 429 into a hot
 * retry loop against a host that has just asked us to stop.
 */
export function retryAtFrom(
  retryAfter: null | number | string,
  now = Date.now(),
): number {
  if (typeof retryAfter === "number") return retryAfter;
  if (!retryAfter?.trim()) return now + fallbackBlockMs;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return now + seconds * 1_000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? date : now + fallbackBlockMs;
}

// RFC 9331 defines RateLimit-Reset as delta-seconds; GitHub and others send a
// Unix timestamp instead, and nothing in either value says which it is. The
// magnitudes do not overlap: 1e9 seconds is 2001-09 as an epoch and 31 years
// as a delta, so anything smaller is a delta and anything larger is an epoch.
const resetEpochThresholdSeconds = 1e9;

function resetInstant(reset: number, now: number): number | undefined {
  if (!Number.isFinite(reset) || reset < 0) return undefined;
  const instant =
    reset < resetEpochThresholdSeconds ? now + reset * 1_000 : reset * 1_000;
  return instant > now ? instant : undefined;
}

/**
 * When an origin's own rate-limit headers say to stop, or undefined when they
 * do not. Acts at one remaining rather than zero: the request that would spend
 * the last unit is the one worth holding back.
 *
 * Both spellings are read: RFC 9331 standardised the un-prefixed names, and
 * the `X-` forms predate it and are still the common ones in the wild.
 */
export function rateLimitBlockUntil(
  headers: Headers,
  now = Date.now(),
): number | undefined {
  const remainingHeader =
    headers.get("ratelimit-remaining") ?? headers.get("x-ratelimit-remaining");
  const resetHeader =
    headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset");
  if (!remainingHeader?.trim() || !resetHeader?.trim()) return undefined;

  const remaining = Number(remainingHeader);
  if (!Number.isFinite(remaining) || remaining > 1) return undefined;
  return resetInstant(Number(resetHeader), now);
}

export class HttpRateLimiter {
  constructor(private readonly redis: RateLimitRedis) {}

  async reserve(
    hostname: string,
    priority: "background" | "interactive",
    deadline: RequestDeadline,
  ): Promise<void> {
    const delay = feedDelayMs;
    const until = await this.blockedUntil(hostname, deadline);
    if (until > Date.now()) throw new HttpDeferredError(until);

    if (priority === "background") {
      const waiters = Number(
        (await deadline.run(
          this.redis.get(`${interactivePrefix}${hostname}`),
        )) ?? "0",
      );
      if (waiters > 0 || !(await this.reserveSlot(hostname, delay, deadline))) {
        throw new HttpDeferredError(Date.now() + delay);
      }
      return;
    }

    const reservationDeadline = Date.now() + interactiveWaitMs;
    let waiting = false;
    try {
      /* eslint-disable no-await-in-loop -- Reservation and waiter state are updated between polls. */
      while (Date.now() < reservationDeadline) {
        if (await this.reserveSlot(hostname, delay, deadline)) return;
        if (!waiting) {
          waiting = true;
          await deadline.run(
            this.redis.incr(`${interactivePrefix}${hostname}`),
          );
          await deadline.run(
            this.redis.expire(`${interactivePrefix}${hostname}`, 6),
          );
        }
        await deadline.sleep(50);
      }
      /* eslint-enable no-await-in-loop */
      throw new HttpDeferredError(Date.now() + delay);
    } finally {
      if (waiting) {
        await deadline.run(this.redis.decr(`${interactivePrefix}${hostname}`));
      }
    }
  }

  async reserveSlot(
    hostname: string,
    delay: number,
    deadline: RequestDeadline,
  ): Promise<boolean> {
    return (
      (await deadline.run(
        this.redis.set(
          `${intervalPrefix}${hostname}`,
          "1",
          "PX",
          delay.toString(),
          "NX",
        ),
      )) === "OK"
    );
  }

  async blockedUntil(
    hostname: string,
    deadline: RequestDeadline,
  ): Promise<number> {
    return Number.parseInt(
      (await deadline.run(this.redis.get(`${blockedPrefix}${hostname}`))) ??
        "0",
      10,
    );
  }

  async applyRateLimitHeaders(
    hostname: string,
    headers: Headers,
    deadline: RequestDeadline,
  ): Promise<void> {
    const until = rateLimitBlockUntil(headers);
    if (until !== undefined) await this.block(hostname, until, deadline);
  }

  async block(
    hostname: string,
    retryAfter: string | number | null,
    deadline: RequestDeadline,
  ): Promise<number> {
    const retryAt = retryAtFrom(retryAfter);
    await deadline.run(
      this.redis.set(
        `${blockedPrefix}${hostname}`,
        retryAt.toString(),
        "PX",
        Math.max(1, retryAt - Date.now()),
      ),
    );
    return retryAt;
  }
}
