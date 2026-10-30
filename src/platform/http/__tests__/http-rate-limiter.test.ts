import { describe, expect, spyOn, test } from "bun:test";
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
import {
  HttpDeadlineError,
  RequestDeadline,
} from "#platform/http/request-deadline.ts";

const now = Date.UTC(2026, 0, 1, 12, 0, 0);
const fiveMinutes = 5 * 60_000;

// A missing or unreadable header falls back to five minutes: "right now"
// would turn a 429 into a hot retry loop against a host that has just asked us
// to stop. A date in the past is honoured as-is; it means "try again now", and
// the caller compares against the clock anyway.
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

// The request that would spend the last unit is the one worth holding back, so
// a block starts at one remaining rather than at zero. RFC 9331 defines reset
// as delta-seconds and GitHub sends an epoch; a delta of 60 read as an epoch is
// 1970, which silently dropped the header.
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
  // A block that clears inside the deadline used to fail the request outright,
  // with no wait at all.
  test("sleeps out a block that clears inside the deadline", async () => {
    const redis = createFakeHttpRedis();
    redis.seed("http-blocked:feeds.example.com", String(Date.now() + 200), 200);
    const deadline = new RequestDeadline(20_000);
    // The requested wait, not wall-clock time: the block was seeded before
    // the call, so elapsed time can legitimately land a millisecond short.
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
      const error = await new HttpRateLimiter(redis)
        .reserve("feeds.example.com", "background", deadline)
        .catch((caught: unknown) => caught);
      // A block the origin asked for, not the limiter's own pacing.
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
    redis.seed(lastKey, String(Date.now() - 9_000), 10_000);

    const error = await reserve(limiter, "background").catch(
      (caught: unknown) => caught,
    );
    // The limiter's own pacing, which a caller can tell from a block.
    expect(error).toBeInstanceOf(HttpPacedError);
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

  // The production default, read off the wait the limiter asks for rather
  // than off the wall clock.
  test("interactive requests to one host sit one second apart by default", async () => {
    const redis = createFakeHttpRedis();
    redis.seed(lastKey, String(Date.now()), 10_000);
    const deadline = new RequestDeadline(20_000);
    using slept = spyOn(deadline, "sleep").mockImplementation(async () => {
      redis.seed(lastKey, String(Date.now() - 10_000), 10_000);
    });

    await reserve(new HttpRateLimiter(redis), "interactive", deadline);

    expect(slept).toHaveBeenCalledTimes(1);
    const [waited] = slept.mock.calls[0] ?? [];
    expect(waited).toBeGreaterThanOrEqual(990);
    expect(waited).toBeLessThanOrEqual(1_000);
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
});
