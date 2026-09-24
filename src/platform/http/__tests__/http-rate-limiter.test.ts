import { describe, expect, test } from "bun:test";
import {
  HttpRateLimiter,
  rateLimitBlockUntil,
  retryAtFrom,
} from "../http-rate-limiter.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import {
  HttpDeadlineError,
  RequestDeadline,
} from "#platform/http/request-deadline.ts";

const now = Date.UTC(2026, 0, 1, 12, 0, 0);
const fiveMinutes = 5 * 60_000;

describe("retryAtFrom", () => {
  test("passes an absolute instant straight through", () => {
    expect(retryAtFrom(now + 1_000, now)).toBe(now + 1_000);
  });

  test("reads a delta in seconds", () => {
    expect(retryAtFrom("120", now)).toBe(now + 120_000);
  });

  test("reads an HTTP date", () => {
    const when = now + 90_000;
    expect(retryAtFrom(new Date(when).toUTCString(), now)).toBe(when);
  });

  // Falling back to "right now" would turn a 429 into a hot retry loop
  // against a host that has just asked us to stop.
  test("falls back to five minutes when the header is absent", () => {
    expect(retryAtFrom(null, now)).toBe(now + fiveMinutes);
    expect(retryAtFrom("", now)).toBe(now + fiveMinutes);
    expect(retryAtFrom("   ", now)).toBe(now + fiveMinutes);
  });

  test("falls back to five minutes on an unparseable header", () => {
    expect(retryAtFrom("later", now)).toBe(now + fiveMinutes);
  });

  // A Retry-After in the past is honoured as-is; it means "try again now",
  // and the caller compares against the clock anyway.
  test("honours a date already in the past", () => {
    const when = now - 60_000;
    expect(retryAtFrom(new Date(when).toUTCString(), now)).toBe(when);
  });
});

const headers = (entries: Record<string, string>) => new Headers(entries);

describe("rateLimitBlockUntil", () => {
  test("has no opinion without both headers", () => {
    expect(rateLimitBlockUntil(headers({}), now)).toBeUndefined();
    expect(
      rateLimitBlockUntil(headers({ "x-ratelimit-remaining": "0" }), now),
    ).toBeUndefined();
    expect(
      rateLimitBlockUntil(headers({ "x-ratelimit-reset": "1" }), now),
    ).toBeUndefined();
  });

  test("does not block while budget remains", () => {
    const plenty = headers({
      "x-ratelimit-remaining": "50",
      "x-ratelimit-reset": String((now + 60_000) / 1_000),
    });
    expect(rateLimitBlockUntil(plenty, now)).toBeUndefined();
  });

  // The request that would spend the last unit is the one worth holding back,
  // so this acts at one remaining rather than at zero.
  test("blocks at one remaining, not just at zero", () => {
    const reset = (now + 60_000) / 1_000;
    const one = headers({
      "x-ratelimit-remaining": "1",
      "x-ratelimit-reset": String(reset),
    });
    expect(rateLimitBlockUntil(one, now)).toBe(reset * 1_000);

    const none = headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
    });
    expect(rateLimitBlockUntil(none, now)).toBe(reset * 1_000);
  });

  test("ignores a reset that has already passed", () => {
    const stale = headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String((now - 60_000) / 1_000),
    });
    expect(rateLimitBlockUntil(stale, now)).toBeUndefined();
  });

  test("ignores an unparseable reset", () => {
    const bad = headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "soon",
    });
    expect(rateLimitBlockUntil(bad, now)).toBeUndefined();
  });
});

describe("rateLimitBlockUntil header spellings and reset units", () => {
  test("reads an epoch reset with un-prefixed header names", () => {
    const reset = (now + 60_000) / 1_000;
    expect(
      rateLimitBlockUntil(
        headers({
          "ratelimit-remaining": "0",
          "ratelimit-reset": String(reset),
        }),
        now,
      ),
    ).toBe(reset * 1_000);
  });

  test("prefers the un-prefixed name when both are present", () => {
    const standard = (now + 60_000) / 1_000;
    expect(
      rateLimitBlockUntil(
        headers({
          "ratelimit-remaining": "0",
          "ratelimit-reset": String(standard),
          "x-ratelimit-remaining": "500",
          "x-ratelimit-reset": String((now + 3_600_000) / 1_000),
        }),
        now,
      ),
    ).toBe(standard * 1_000);
  });

  // RFC 9331 defines reset as delta-seconds; GitHub sends an epoch. A delta
  // of 60 read as an epoch is 1970, which silently dropped the header.
  test("reads a small reset as delta-seconds", () => {
    expect(
      rateLimitBlockUntil(
        headers({ "ratelimit-remaining": "0", "ratelimit-reset": "60" }),
        now,
      ),
    ).toBe(now + 60_000);
  });

  test("ignores a delta of zero and a negative reset", () => {
    expect(
      rateLimitBlockUntil(
        headers({ "ratelimit-remaining": "0", "ratelimit-reset": "0" }),
        now,
      ),
    ).toBeUndefined();
    expect(
      rateLimitBlockUntil(
        headers({ "ratelimit-remaining": "0", "ratelimit-reset": "-60" }),
        now,
      ),
    ).toBeUndefined();
  });

  test("ignores an unparseable remaining count", () => {
    expect(
      rateLimitBlockUntil(
        headers({ "ratelimit-remaining": "none", "ratelimit-reset": "60" }),
        now,
      ),
    ).toBeUndefined();
  });
});

describe("HttpRateLimiter.reserve for an interactive caller", () => {
  // A block that clears inside the deadline used to fail the request outright,
  // with no wait at all.
  test("sleeps out a block that clears inside the deadline", async () => {
    const redis = createFakeHttpRedis();
    redis.seed("http-blocked:feeds.example.com", String(Date.now() + 200), 200);
    const deadline = new RequestDeadline(20_000);
    const started = Date.now();

    try {
      await new HttpRateLimiter(redis).reserve(
        "feeds.example.com",
        "interactive",
        deadline,
      );
    } finally {
      deadline.dispose();
    }

    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  // Past the deadline it is a real deferral: the caller cannot afford the wait.
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

  // Background work defers instead of holding a worker slot for the wait.
  test("still defers background work behind a block", async () => {
    const redis = createFakeHttpRedis();
    redis.seed("http-blocked:feeds.example.com", String(Date.now() + 200), 200);
    const deadline = new RequestDeadline(20_000);

    try {
      await expect(
        new HttpRateLimiter(redis).reserve(
          "feeds.example.com",
          "background",
          deadline,
        ),
      ).rejects.toBeInstanceOf(HttpDeferredError);
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

  test("two interactive requests issued together go out one second apart", async () => {
    const limiter = new HttpRateLimiter(createFakeHttpRedis());
    const [first = 0, second = 0] = (
      await Promise.all([
        reserve(limiter, "interactive"),
        reserve(limiter, "interactive"),
      ])
    ).toSorted((left, right) => left - right);

    expect(second - first).toBeGreaterThanOrEqual(990);
    expect(second - first).toBeLessThan(1_500);
  });

  test("background defers within ten seconds of an interactive request", async () => {
    const redis = createFakeHttpRedis();
    const limiter = new HttpRateLimiter(redis);
    await reserve(limiter, "interactive");
    redis.seed(lastKey, String(Date.now() - 9_000), 10_000);

    const error = await reserve(limiter, "background").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpDeferredError);
    if (!(error instanceof HttpDeferredError)) throw error;
    expect(error.retryAt - Date.now()).toBeGreaterThan(900);
    expect(error.retryAt - Date.now()).toBeLessThanOrEqual(1_000);
  });

  test("interactive proceeds one second after a background request", async () => {
    const redis = createFakeHttpRedis();
    const limiter = new HttpRateLimiter(redis);
    await reserve(limiter, "background");
    redis.seed(lastKey, String(Date.now() - 1_000), 10_000);
    const started = Date.now();

    await reserve(limiter, "interactive");
    expect(Date.now() - started).toBeLessThan(50);
  });

  // The wait used to end after one interval, so the third of three queued
  // requests deferred even with most of its deadline left.
  test("queued interactive requests are served in turn within their deadline", async () => {
    const limiter = new HttpRateLimiter(createFakeHttpRedis(), {
      background: 10_000,
      interactive: 200,
    });
    const times = (
      await Promise.all(
        [1, 2, 3].map(async () =>
          reserve(limiter, "interactive", new RequestDeadline(2_000)),
        ),
      )
    ).toSorted((left, right) => left - right);

    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(190);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(190);
  });

  test("an interactive wait that outlasts the deadline defers up front", async () => {
    const redis = createFakeHttpRedis();
    redis.seed(lastKey, String(Date.now()), 10_000);
    const started = Date.now();

    const error = await reserve(
      new HttpRateLimiter(redis),
      "interactive",
      new RequestDeadline(500),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpDeferredError);
    expect(Date.now() - started).toBeLessThan(50);
    expect(redis.pttl(`http-interactive:${host}`)).toBe(-2);
  });
});

describe("HttpRateLimiter interactive waiter accounting", () => {
  const host = "feeds.example.com";
  const lastKey = `http-last-request:${host}`;
  const waitersKey = `http-interactive:${host}`;
  const intervals = { background: 10_000, interactive: 200 };

  // Starts an interactive reservation against a host that was just
  // requested, and returns once it has registered as a waiter.
  async function startWaiter(
    redis: ReturnType<typeof createFakeHttpRedis>,
    deadline = new RequestDeadline(20_000),
  ) {
    const reservation = new HttpRateLimiter(redis, intervals)
      .reserve(host, "interactive", deadline)
      .finally(() => {
        deadline.dispose();
      });
    await Bun.sleep(20);
    return { deadline, reservation };
  }

  function requestedJustNow(redis: ReturnType<typeof createFakeHttpRedis>) {
    redis.seed(lastKey, String(Date.now()), intervals.background);
  }

  test("keeps the waiter visible for the whole request deadline", async () => {
    const redis = createFakeHttpRedis();
    requestedJustNow(redis);
    const { reservation } = await startWaiter(redis);

    expect(redis.pttl(waitersKey)).toBeGreaterThan(19_900);
    const background = new RequestDeadline(1_000);
    try {
      await expect(
        new HttpRateLimiter(redis, intervals).reserve(
          host,
          "background",
          background,
        ),
      ).rejects.toBeInstanceOf(HttpDeferredError);
    } finally {
      background.dispose();
    }

    await reservation;
    expect(redis.pttl(waitersKey)).toBe(-2);
  });

  test("overlapping waiters count each other in and out", async () => {
    const redis = createFakeHttpRedis();
    requestedJustNow(redis);
    const first = await startWaiter(redis);
    const second = await startWaiter(redis);
    expect(redis.values.get(waitersKey)).toBe("2");

    // One of them takes the clock; the other waits its turn and stays counted.
    await Promise.race([first.reservation, second.reservation]);
    expect(redis.values.get(waitersKey)).toBe("1");
    expect(redis.pttl(waitersKey)).toBeGreaterThan(19_000);

    await Promise.all([first.reservation, second.reservation]);
    expect(redis.pttl(waitersKey)).toBe(-2);
  });

  test("a turn lost too close to the deadline defers and takes the waiter out", async () => {
    const redis = createFakeHttpRedis();
    requestedJustNow(redis);
    const { reservation } = await startWaiter(redis, new RequestDeadline(600));

    // Another instance takes the clock while this one sleeps, pushing its
    // turn past the deadline.
    redis.seed(lastKey, String(Date.now() + 1_000), intervals.background);
    await expect(reservation).rejects.toBeInstanceOf(HttpDeferredError);
    expect(redis.pttl(waitersKey)).toBe(-2);
  });

  test("a cancelled wait takes the waiter out", async () => {
    const redis = createFakeHttpRedis();
    requestedJustNow(redis);
    const { deadline, reservation } = await startWaiter(redis);

    deadline.controller.abort();
    await expect(reservation).rejects.toBeInstanceOf(HttpDeadlineError);
    expect(redis.pttl(waitersKey)).toBe(-2);
  });

  test("cleanup after the counter expired leaves no negative key behind", async () => {
    const redis = createFakeHttpRedis();
    requestedJustNow(redis);
    const { reservation } = await startWaiter(redis);

    redis.values.delete(waitersKey);
    await reservation;
    expect(redis.pttl(waitersKey)).toBe(-2);
  });
});
