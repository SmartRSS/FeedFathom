import { describe, expect, test } from "bun:test";
import {
  cacheable,
  currentAge,
  deltaSeconds,
  expiresAt,
  refresh,
  sharedCacheAllowed,
} from "../http-cache-policy.ts";

const second = 1_000;
const at = Date.UTC(2026, 0, 1, 12, 0, 0);
const httpDate = (instant: number) => new Date(instant).toUTCString();

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

// Some origins quote Age. Anything that is not a plain integer is absent
// rather than zero, so a malformed value falls through to the next rule
// instead of pinning freshness to now.
test.each<[string, number | undefined]>([
  ["60", 60],
  ["0", 0],
  ["  60 ", 60],
  ['"60"', 60],
  ["60.5", undefined],
  ["-60", undefined],
  ["soon", undefined],
  ["", undefined],
  ["60 ,", undefined],
  ["9".repeat(20), undefined],
])("deltaSeconds(%p) is %p", (value, expected) => {
  expect(deltaSeconds(value)).toBe(expected);
});

// Each refusal marks a response as belonging to one requester; replaying it to
// another user of the instance would be a data leak.
test.each<[Record<string, string>, boolean]>([
  [{}, true],
  [{ "cache-control": "max-age=60" }, true],
  [{ "cache-control": "no-store" }, false],
  [{ "cache-control": "max-age=60, private" }, false],
  [{ vary: "*" }, false],
  [{ vary: " * " }, false],
  [{ vary: "accept-encoding" }, true],
  [{ "set-cookie": "sid=1" }, false],
  [{ "cache-control": "No-Store" }, false],
])("sharedCacheAllowed(%p) is %p", (entries, expected) => {
  expect(sharedCacheAllowed(headers(entries))).toBe(expected);
});

// The greater of apparent age and a reported Age, so a lying intermediary can
// shorten our freshness but never extend it.
test.each<[string, Record<string, string>, number]>([
  ["a response dated now", { date: httpDate(at) }, 0],
  ["the gap since Date", { date: httpDate(at - 30 * second) }, 30 * second],
  [
    "a reported Age above the apparent age",
    { age: "90", date: httpDate(at - 30 * second) },
    90 * second,
  ],
  ["a Date in the future", { date: httpDate(at + 60 * second) }, 0],
  ["an unparseable Date", { date: "whenever" }, 0],
])("currentAge for %s", (_name, entries, expected) => {
  expect(currentAge(headers(entries), at)).toBe(expected);
});

// This is a shared cache, so s-maxage wins. Ambiguous or malformed input is
// treated as stale rather than guessed at, and a response that spent its whole
// lifetime in an intermediary arrives stale.
test.each<[string, Record<string, string>, number | undefined]>([
  ["nothing that says", {}, undefined],
  ["max-age", { "cache-control": "max-age=60" }, at + 60 * second],
  [
    "s-maxage over max-age",
    { "cache-control": "max-age=60, s-maxage=600" },
    at + 600 * second,
  ],
  ["no-cache", { "cache-control": "no-cache, max-age=600" }, at],
  ["a repeated max-age", { "cache-control": "max-age=60, max-age=600" }, at],
  ["an unparseable max-age", { "cache-control": "max-age=abc" }, at],
  [
    "an Age already carried",
    { age: "40", "cache-control": "max-age=60" },
    at + 20 * second,
  ],
  [
    "an Age beyond the lifetime",
    { age: "600", "cache-control": "max-age=60" },
    at,
  ],
  [
    "Expires relative to Date",
    { date: httpDate(at), expires: httpDate(at + 300 * second) },
    at + 300 * second,
  ],
  [
    "an Expires already past",
    { date: httpDate(at), expires: httpDate(at - 300 * second) },
    at,
  ],
  ["an unparseable Expires", { expires: "soon" }, undefined],
  [
    "max-age over Expires",
    {
      "cache-control": "max-age=60",
      date: httpDate(at),
      expires: httpDate(at + 86_400 * second),
    },
    at + 60 * second,
  ],
])("expiresAt with %s", (_name, entries, expected) => {
  expect(expiresAt(headers(entries), at)).toBe(expected);
});

function nativeResponse(init: {
  headers: Headers;
  status?: number;
  url?: string;
}) {
  return {
    headers: init.headers,
    status: init.status ?? 200,
    url: init.url ?? "https://example.test/feed",
  };
}

describe("cacheable", () => {
  const body = Buffer.from("hello");
  const url = "https://example.test/feed";

  test("stores a fresh response", () => {
    const entry = cacheable(
      nativeResponse({ headers: headers({ "cache-control": "max-age=60" }) }),
      body,
      url,
    );
    expect(entry?.body).toBe(body.toString("base64"));
    expect(entry?.status).toBe(200);
  });

  // An already-stale response is still worth storing with a validator: the
  // next fetch becomes a conditional request that can return 304.
  test.each([
    ["one that may not be shared", { "cache-control": "no-store" }, false],
    [
      "a stale one with nothing to revalidate against",
      { "cache-control": "max-age=0" },
      false,
    ],
    [
      "a stale one carrying an etag",
      { "cache-control": "max-age=0", etag: '"v1"' },
      true,
    ],
    ["one carrying last-modified", { "last-modified": httpDate(at) }, true],
  ])("stores %s: %p", (_case, fields, stored) => {
    const entry = cacheable(
      nativeResponse({ headers: headers(fields) }),
      body,
      url,
    );
    expect(entry !== undefined).toBe(stored);
  });

  // The post-redirect URL is what a later request must revalidate against.
  test("records the response's own url, falling back to the requested one", () => {
    const redirected = cacheable(
      nativeResponse({
        headers: headers({ etag: '"v1"' }),
        url: "https://example.test/final",
      }),
      body,
      url,
    );
    expect(redirected?.url).toBe("https://example.test/final");

    const noUrl = cacheable(
      nativeResponse({ headers: headers({ etag: '"v1"' }), url: "" }),
      body,
      url,
    );
    expect(noUrl?.url).toBe(url);
  });
});

describe("refresh", () => {
  const stored = {
    body: "aGk=",
    expiresAt: at,
    headers: [
      ["etag", '"v1"'],
      ["date", httpDate(at - 600 * second)],
      ["age", "600"],
    ] as [string, string][],
    status: 200,
    url: "https://example.test/feed",
  };

  test("refreshes freshness after a 304 while preserving the stored response", () => {
    const before = Math.floor(Date.now() / second) * second;
    const next = refresh(stored, headers({ "cache-control": "max-age=60" }));
    const nextHeaders = new Headers(next.headers);
    const stamped = Date.parse(nextHeaders.get("date") ?? "");

    expect(next.body).toBe(stored.body);
    expect(next.status).toBe(stored.status);
    expect(nextHeaders.get("age")).toBeNull();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
    expect(next.expiresAt).toBe(stamped + 60 * second);
  });

  test("overwrites stored headers the 304 restates", () => {
    const next = refresh(stored, headers({ etag: '"v2"' }));
    expect(new Headers(next.headers).get("etag")).toBe('"v2"');
  });

  test("keeps an Age the 304 did restate", () => {
    const next = refresh(stored, headers({ age: "5" }));
    expect(new Headers(next.headers).get("age")).toBe("5");
  });
});
