import { describe, expect, test } from "bun:test";
import { rateLimitBlockUntil, retryAtFrom } from "./http-rate-limiter.ts";

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
