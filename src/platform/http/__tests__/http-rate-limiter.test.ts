import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import {
  HttpRateLimiter,
  rateLimitBlockUntil,
  retryAtFrom,
} from "../http-rate-limiter.ts";
import {
  HttpDeferredError,
  HttpPacedError,
} from "#platform/http/http-deferred-error.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import { RequestDeadline } from "#platform/http/request-deadline.ts";

const now = Date.UTC(2026, 0, 1, 12, 0, 0);
const fiveMinutes = 5 * 60_000;

test.each<[string, number | null | string, number]>([
  ["an absolute instant", now + 1_000, now + 1_000],
  ["a delta in seconds", "120", now + 120_000],
  ["an HTTP date", new Date(now + 90_000).toUTCString(), now + 90_000],
  ["an absent header", null, now + fiveMinutes],
  ["an empty header", "", now + fiveMinutes],
  ["a blank header", "   ", now + fiveMinutes],
  ["an unparseable header", "later", now + fiveMinutes],
  ["a date already past", new Date(now - 60_000).toUTCString(), now - 60_000],
])("retryAtFrom reads %s", (_name, header, expected) => {
  expect(retryAtFrom(header, now)).toBe(expected);
});

const epoch = (at: number) => String(at / 1_000);

test.each<[string, Record<string, string>, number | undefined]>([
  ["no headers", {}, undefined],
  ["remaining without reset", { "x-ratelimit-remaining": "0" }, undefined],
  ["reset without remaining", { "x-ratelimit-reset": "1" }, undefined],
  [
    "budget left",
    {
      "x-ratelimit-remaining": "50",
      "x-ratelimit-reset": epoch(now + 60_000),
    },
    undefined,
  ],
  [
    "one remaining",
    { "x-ratelimit-remaining": "1", "x-ratelimit-reset": epoch(now + 60_000) },
    now + 60_000,
  ],
  [
    "none remaining",
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": epoch(now + 60_000) },
    now + 60_000,
  ],
  [
    "a reset already past",
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": epoch(now - 60_000) },
    undefined,
  ],
  [
    "an unparseable reset",
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "soon" },
    undefined,
  ],
  [
    "un-prefixed names with an epoch reset",
    { "ratelimit-remaining": "0", "ratelimit-reset": epoch(now + 60_000) },
    now + 60_000,
  ],
  [
    "both spellings, preferring the un-prefixed one",
    {
      "ratelimit-remaining": "0",
      "ratelimit-reset": epoch(now + 60_000),
      "x-ratelimit-remaining": "500",
      "x-ratelimit-reset": epoch(now + 3_600_000),
    },
    now + 60_000,
  ],
  [
    "a small reset as delta-seconds",
    { "ratelimit-remaining": "0", "ratelimit-reset": "60" },
    now + 60_000,
  ],
  [
    "a delta of zero",
    { "ratelimit-remaining": "0", "ratelimit-reset": "0" },
    undefined,
  ],
  [
    "a negative reset",
    { "ratelimit-remaining": "0", "ratelimit-reset": "-60" },
    undefined,
  ],
  [
    "an unparseable remaining count",
    { "ratelimit-remaining": "none", "ratelimit-reset": "60" },
    undefined,
  ],
])("rateLimitBlockUntil with %s", (_name, entries, expected) => {
  expect(rateLimitBlockUntil(new Headers(entries), now)).toBe(expected);
});

describe("HttpRateLimiter.reserve for an interactive caller", () => {
  test("sleeps out a block that clears inside the deadline", async () => {
    const redis = createFakeHttpRedis();
    redis.seed("http-blocked:feeds.example.com", String(Date.now() + 200), 200);
    const deadline = new RequestDeadline(20_000);
    using slept = spyOn(deadline, "sleep").mockResolvedValue();

    try {
      await new HttpRateLimiter(redis).reserve(
        "feeds.example.com",
        "interactive",
        deadline,
      );
    } finally {
      deadline.dispose();
    }

    expect(slept).toHaveBeenCalledTimes(1);
    const [waited] = slept.mock.calls[0] ?? [];
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(200);
  });

  test("still defers a block that outlasts the deadline", async () => {
    const redis = createFakeHttpRedis();
    const retryAt = Date.now() + 60_000;
    redis.seed("http-blocked:feeds.example.com", String(retryAt), 60_000);
    const deadline = new RequestDeadline(1_000);

    try {
      const error = await new HttpRateLimiter(redis)
        .reserve("feeds.example.com", "interactive", deadline)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpDeferredError);
      if (!(error instanceof HttpDeferredError)) throw error;
      expect(error.retryAt).toBe(retryAt);
    } finally {
      deadline.dispose();
    }
  });

  test("still defers background work behind a block", async () => {
    const redis = createFakeHttpRedis();
    redis.seed("http-blocked:feeds.example.com", String(Date.now() + 200), 200);
    const deadline = new RequestDeadline(20_000);

    try {
      const error = await new HttpRateLimiter(redis)
        .reserve("feeds.example.com", "background", deadline)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpDeferredError);
      expect(error).not.toBeInstanceOf(HttpPacedError);
    } finally {
      deadline.dispose();
    }
  });
});

describe("HttpRateLimiter shared host clock", () => {
  const host = "feeds.example.com";
  const lastKey = `http-last-request:${host}`;

  async function reserve(
    limiter: HttpRateLimiter,
    priority: "background" | "interactive",
    deadline = new RequestDeadline(20_000),
  ) {
    try {
      await limiter.reserve(host, priority, deadline);
    } finally {
      deadline.dispose();
    }
    return Date.now();
  }

  test("background defers within ten seconds of an interactive request", async () => {
    const redis = createFakeHttpRedis();
    const limiter = new HttpRateLimiter(redis);
    await reserve(limiter, "interactive");
    const requestedAt = Date.now() - 9_000;
    redis.seed(lastKey, String(requestedAt), 10_000);

    const error = await reserve(limiter, "background").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpPacedError);
    if (!(error instanceof HttpDeferredError)) throw error;
    expect(Math.abs(error.retryAt - (requestedAt + 10_000))).toBeLessThan(50);
  });

  test("interactive proceeds one second after a background request", async () => {
    const redis = createFakeHttpRedis();
    const limiter = new HttpRateLimiter(redis);
    await reserve(limiter, "background");
    redis.seed(lastKey, String(Date.now() - 1_000), 10_000);
    const deadline = new RequestDeadline(20_000);
    using slept = spyOn(deadline, "sleep");

    await reserve(limiter, "interactive", deadline);
    expect(slept).not.toHaveBeenCalled();
  });

  test("interactive requests to one host sit one second apart by default", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const redis = createFakeHttpRedis();
      redis.seed(lastKey, String(Date.now()), 10_000);
      const deadline = new RequestDeadline(20_000);
      using slept = spyOn(deadline, "sleep").mockImplementation(async () => {
        redis.seed(lastKey, String(Date.now() - 10_000), 10_000);
      });

      await reserve(new HttpRateLimiter(redis), "interactive", deadline);

      expect(slept.mock.calls).toEqual([[1_000]]);
    } finally {
      setSystemTime();
    }
  });

  test("queued interactive requests are served in turn within their deadline", async () => {
    const limiter = new HttpRateLimiter(createFakeHttpRedis(), {
      background: 10_000,
      interactive: 200,
    });
    await Promise.all(
      [1, 2, 3].map(async () =>
        reserve(limiter, "interactive", new RequestDeadline(5_000)),
      ),
    );
  });

  test("an interactive wait that outlasts the deadline defers up front", async () => {
    const redis = createFakeHttpRedis();
    redis.seed(lastKey, String(Date.now()), 10_000);
    const deadline = new RequestDeadline(500);
    using slept = spyOn(deadline, "sleep");

    const error = await reserve(
      new HttpRateLimiter(redis),
      "interactive",
      deadline,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpDeferredError);
    expect(slept).not.toHaveBeenCalled();
    expect(redis.pttl(`http-interactive:${host}`)).toBe(-2);
  });
});

describe("HttpRateLimiter interactive waiter accounting", () => {
  const host = "feeds.example.com";
  const lastKey = `http-last-request:${host}`;
  const intervals = { background: 10_000, interactive: 10_000 };

  async function startWaiter(redis: ReturnType<typeof createFakeHttpRedis>) {
    const deadline = new RequestDeadline(20_000);
    const sleeping = Promise.withResolvers<void>();
    const woken = Promise.withResolvers<void>();
    spyOn(deadline, "sleep").mockImplementation(async () => {
      sleeping.resolve();
      return woken.promise;
    });
    const reservation = new HttpRateLimiter(redis, intervals)
      .reserve(host, "interactive", deadline)
      .finally(() => {
        deadline.dispose();
      });
    await sleeping.promise;
    return { deadline, reservation, wake: woken.resolve };
  }

  async function backgroundGoesAhead(
    redis: ReturnType<typeof createFakeHttpRedis>,
  ) {
    await redis.del(lastKey);
    const deadline = new RequestDeadline(1_000);
    try {
      await new HttpRateLimiter(redis, intervals).reserve(
        host,
        "background",
        deadline,
      );
      return true;
    } catch (error) {
      if (error instanceof HttpDeferredError) return false;
      throw error;
    } finally {
      deadline.dispose();
    }
  }

  function requestedJustNow(redis: ReturnType<typeof createFakeHttpRedis>) {
    redis.seed(lastKey, String(Date.now()), intervals.background);
  }

  test("a waiting interactive request holds background work back for its whole deadline, until it is cancelled", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const redis = createFakeHttpRedis();
      requestedJustNow(redis);
      const { deadline, reservation, wake } = await startWaiter(redis);

      setSystemTime(new Date("2026-01-01T00:00:19Z"));
      expect(await backgroundGoesAhead(redis)).toBe(false);

      deadline.controller.abort(new Error("client left"));
      wake();
      await expect(reservation).rejects.toThrow("client left");
      expect(await backgroundGoesAhead(redis)).toBe(true);
    } finally {
      setSystemTime();
    }
  });

  test("a turn lost too close to the deadline defers and stops holding background work back", async () => {
    const redis = createFakeHttpRedis();
    requestedJustNow(redis);
    const { reservation, wake } = await startWaiter(redis);

    redis.seed(lastKey, String(Date.now() + 30_000), intervals.background);
    wake();
    await expect(reservation).rejects.toBeInstanceOf(HttpDeferredError);
    expect(await backgroundGoesAhead(redis)).toBe(true);
  });
});
