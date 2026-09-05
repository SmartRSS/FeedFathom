import { describe, expect, test } from "bun:test";
import {
  HttpRateLimiter,
  rateLimitBlockUntil,
  retryAtFrom,
} from "../http-rate-limiter.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { RequestDeadline } from "#platform/http/request-deadline.ts";

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
  // RFC 9331 standardised the un-prefixed names; the X- forms predate it.
  test("reads the un-prefixed RFC 9331 names", () => {
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

  test("still reads a large reset as an epoch timestamp", () => {
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

// A stub with real PX expiry, because the whole point of these cases is when
// a key stops existing.
function expiringRedis() {
  const values = new Map<string, { expiresAt: number; value: string }>();
  const live = (key: string) => {
    const entry = values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async decr(key: string) {
      const next = String(Number(live(key)?.value ?? "0") - 1);
      values.set(key, { expiresAt: Date.now() + 60_000, value: next });
      return Number(next);
    },
    async expire() {
      return 1;
    },
    async get(key: string) {
      return live(key)?.value ?? null;
    },
    async incr(key: string) {
      const next = String(Number(live(key)?.value ?? "0") + 1);
      values.set(key, { expiresAt: Date.now() + 60_000, value: next });
      return Number(next);
    },
    seed(key: string, value: string, ttlMs: number) {
      values.set(key, { expiresAt: Date.now() + ttlMs, value });
    },
    async set(key: string, value: string, ...options: Array<number | string>) {
      if (options.includes("NX") && live(key)) return null;
      const px = options.indexOf("PX");
      const ttl = px === -1 ? 60_000 : Number(options[px + 1]);
      values.set(key, { expiresAt: Date.now() + ttl, value });
      return "OK";
    },
  };
}

describe("HttpRateLimiter.reserve for an interactive caller", () => {
  // The window used to be a flat 2.5s against a 10s interval, so waiting could
  // never succeed on its own -- only by luck, if the slot happened to free
  // early. 27.5s of a 30s deadline went unused and the SPA got a 429 it has no
  // retry for.
  test("waits out an interval longer than the old fixed 2.5s window", async () => {
    const redis = expiringRedis();
    redis.seed("http-interval:feeds.example.com", "1", 2_800);
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

    expect(Date.now() - started).toBeGreaterThan(2_500);
  }, 20_000);

  // A block that clears inside the deadline used to fail the request outright,
  // with no wait at all.
  test("sleeps out a block that clears inside the deadline", async () => {
    const redis = expiringRedis();
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
    const redis = expiringRedis();
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
    const redis = expiringRedis();
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
