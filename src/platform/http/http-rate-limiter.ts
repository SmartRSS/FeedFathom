import {
  HttpDeferredError,
  HttpPacedError,
} from "#platform/http/http-deferred-error.ts";
import type { RequestDeadline } from "#platform/http/request-deadline.ts";

const blockedPrefix = "http-blocked:";
const lastRequestPrefix = "http-last-request:";
const interactivePrefix = "http-interactive:";
const fallbackBlockMs = 5 * 60_000;
const waiterGraceMs = 1_000;

export type HostIntervals = { background: number; interactive: number };

export const defaultIntervals: Readonly<HostIntervals> = Object.freeze({
  background: 10_000,
  interactive: 1_000,
});

const reserveScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local last = tonumber(redis.call('GET', KEYS[1]))
if last and now - last < tonumber(ARGV[1]) then
  return last + tonumber(ARGV[1]) - now
end
redis.call('SET', KEYS[1], now, 'PX', ARGV[2])
return 0`;

const registerWaiterScript = `
redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end`;

const releaseWaiterScript = `
local waiters = tonumber(redis.call('GET', KEYS[1]))
if not waiters then return 0 end
if waiters <= 1 then return redis.call('DEL', KEYS[1]) end
return redis.call('DECR', KEYS[1])`;

type RateLimitRedis = {
  get(key: string): Promise<null | string>;
  send(command: "EVAL", args: string[]): Promise<unknown>;
  set(
    key: string,
    value: string,
    ...options: Array<number | string>
  ): Promise<null | string>;
};

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

const resetEpochThresholdSeconds = 1e9;

function resetInstant(reset: number, now: number): number | undefined {
  if (!Number.isFinite(reset) || reset < 0) return undefined;
  const instant =
    reset < resetEpochThresholdSeconds ? now + reset * 1_000 : reset * 1_000;
  return instant > now ? instant : undefined;
}

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

export type Priority = "background" | "interactive";

export class HttpRateLimiter {
  constructor(
    private readonly redis: RateLimitRedis,
    private readonly intervals = defaultIntervals,
  ) {}

  async reserve(
    hostname: string,
    priority: Priority,
    deadline: RequestDeadline,
  ): Promise<void> {
    const until = await this.blockedUntil(hostname, deadline);
    if (until > Date.now()) {
      if (priority === "background" || until >= deadline.endsAt) {
        throw new HttpDeferredError(until);
      }
      await deadline.sleep(until - Date.now());
    }

    if (priority === "background") {
      const waiters = Number(
        (await deadline.run(
          this.redis.get(`${interactivePrefix}${hostname}`),
        )) ?? "0",
      );
      if (waiters > 0) {
        throw new HttpPacedError(Date.now() + this.intervals.background);
      }
      const wait = await this.reserveGap(hostname, "background", deadline);
      if (wait > 0) throw new HttpPacedError(Date.now() + wait);
      return;
    }

    const waitersKey = `${interactivePrefix}${hostname}`;
    let waiting = false;
    try {
      /* eslint-disable no-await-in-loop -- Another waiter can take the clock between attempts. */
      for (;;) {
        const wait = await this.reserveGap(hostname, "interactive", deadline);
        if (wait === 0) return;
        if (Date.now() + wait >= deadline.endsAt) {
          throw new HttpPacedError(Date.now() + wait);
        }
        if (!waiting) {
          await deadline.run(
            this.redis.send("EVAL", [
              registerWaiterScript,
              "1",
              waitersKey,
              (deadline.endsAt - Date.now() + waiterGraceMs).toString(),
            ]),
          );
          waiting = true;
        }
        await deadline.sleep(wait);
      }
      /* eslint-enable no-await-in-loop */
    } finally {
      if (waiting) {
        void this.redis
          .send("EVAL", [releaseWaiterScript, "1", waitersKey])
          .catch(() => undefined);
      }
    }
  }

  private async reserveGap(
    hostname: string,
    priority: Priority,
    deadline: RequestDeadline,
  ): Promise<number> {
    return Number(
      await deadline.run(
        this.redis.send("EVAL", [
          reserveScript,
          "1",
          `${lastRequestPrefix}${hostname}`,
          this.intervals[priority].toString(),
          this.intervals.background.toString(),
        ]),
      ),
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
