import { Type } from "typebox";
import Schema from "typebox/schema";
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
const finiteNumberCheck = Schema.Compile(Type.Number());

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
  if (finiteNumberCheck.Check(seconds)) return now + seconds * 1_000;
  const date = Date.parse(retryAfter);
  return finiteNumberCheck.Check(date) ? date : now + fallbackBlockMs;
}

/**
 * When an origin's own X-RateLimit headers say to stop, or undefined when they
 * do not. Acts at one remaining rather than zero: the request that would spend
 * the last unit is the one worth holding back.
 */
export function rateLimitBlockUntil(
  headers: Headers,
  now = Date.now(),
): number | undefined {
  const remainingHeader = headers.get("x-ratelimit-remaining");
  const resetHeader = headers.get("x-ratelimit-reset");
  if (!remainingHeader?.trim() || !resetHeader?.trim()) return undefined;

  const remaining = Number(remainingHeader);
  const reset = Number(resetHeader);
  if (remaining <= 1 && finiteNumberCheck.Check(reset) && reset * 1_000 > now) {
    return reset * 1_000;
  }
  return undefined;
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
