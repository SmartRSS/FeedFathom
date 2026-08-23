import { describe, expect, test } from "bun:test";
import {
  cacheable,
  currentAge,
  deltaSeconds,
  expiresAt,
  refresh,
  sharedCacheAllowed,
} from "./http-cache-policy.ts";

const second = 1_000;
const at = Date.UTC(2026, 0, 1, 12, 0, 0);
const httpDate = (instant: number) => new Date(instant).toUTCString();

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("deltaSeconds", () => {
  test("accepts a bare non-negative integer", () => {
    expect(deltaSeconds("60")).toBe(60);
    expect(deltaSeconds("0")).toBe(0);
    expect(deltaSeconds("  60 ")).toBe(60);
  });

  // Some origins quote Age.
  test("accepts a quoted integer", () => {
    expect(deltaSeconds('"60"')).toBe(60);
  });

  // Absent rather than zero, so a malformed value falls through to the next
  // rule instead of pinning freshness to now.
  test("rejects anything that is not a plain integer", () => {
    expect(deltaSeconds("60.5")).toBeUndefined();
    expect(deltaSeconds("-60")).toBeUndefined();
    expect(deltaSeconds("soon")).toBeUndefined();
    expect(deltaSeconds("")).toBeUndefined();
    expect(deltaSeconds("60 ,")).toBeUndefined();
  });

  test("rejects an integer beyond safe precision", () => {
    expect(deltaSeconds("9".repeat(20))).toBeUndefined();
  });
});

describe("sharedCacheAllowed", () => {
  test("allows an ordinary response", () => {
    expect(sharedCacheAllowed(headers({}))).toBe(true);
    expect(sharedCacheAllowed(headers({ "cache-control": "max-age=60" }))).toBe(
      true,
    );
  });

  // Each of these marks a response as belonging to one requester; replaying it
  // to another user of the instance would be a data leak.
  test("refuses no-store", () => {
    expect(sharedCacheAllowed(headers({ "cache-control": "no-store" }))).toBe(
      false,
    );
  });

  test("refuses private", () => {
    expect(
      sharedCacheAllowed(headers({ "cache-control": "max-age=60, private" })),
    ).toBe(false);
  });

  test("refuses a response that varies on everything", () => {
    expect(sharedCacheAllowed(headers({ vary: "*" }))).toBe(false);
    expect(sharedCacheAllowed(headers({ vary: " * " }))).toBe(false);
    expect(sharedCacheAllowed(headers({ vary: "accept-encoding" }))).toBe(true);
  });

  test("refuses a response carrying a cookie", () => {
    expect(sharedCacheAllowed(headers({ "set-cookie": "sid=1" }))).toBe(false);
  });

  test("matches directives case-insensitively", () => {
    expect(sharedCacheAllowed(headers({ "cache-control": "No-Store" }))).toBe(
      false,
    );
  });
});

describe("currentAge", () => {
  test("is zero for a response dated now", () => {
    expect(currentAge(headers({ date: httpDate(at) }), at)).toBe(0);
  });

  test("uses the gap since the response's Date", () => {
    expect(currentAge(headers({ date: httpDate(at - 30 * second) }), at)).toBe(
      30 * second,
    );
  });

  // Taking the greater of the two means a lying intermediary can shorten our
  // freshness but never extend it.
  test("takes the greater of apparent age and a reported Age", () => {
    const withBoth = headers({ age: "90", date: httpDate(at - 30 * second) });
    expect(currentAge(withBoth, at)).toBe(90 * second);
  });

  test("ignores a Date in the future rather than going negative", () => {
    expect(currentAge(headers({ date: httpDate(at + 60 * second) }), at)).toBe(
      0,
    );
  });

  test("treats an unparseable Date as no information", () => {
    expect(currentAge(headers({ date: "whenever" }), at)).toBe(0);
  });
});

describe("expiresAt", () => {
  test("has no opinion when nothing says", () => {
    expect(expiresAt(headers({}), at)).toBeUndefined();
  });

  test("honours max-age", () => {
    expect(expiresAt(headers({ "cache-control": "max-age=60" }), at)).toBe(
      at + 60 * second,
    );
  });

  // This is a shared cache, so the shared directive wins.
  test("prefers s-maxage over max-age", () => {
    expect(
      expiresAt(headers({ "cache-control": "max-age=60, s-maxage=600" }), at),
    ).toBe(at + 600 * second);
  });

  test("expires immediately on no-cache", () => {
    expect(
      expiresAt(headers({ "cache-control": "no-cache, max-age=600" }), at),
    ).toBe(at);
  });

  // Ambiguous or malformed input is treated as stale rather than guessed at.
  test("expires immediately on a repeated max-age", () => {
    expect(
      expiresAt(headers({ "cache-control": "max-age=60, max-age=600" }), at),
    ).toBe(at);
  });

  test("expires immediately on an unparseable max-age", () => {
    expect(expiresAt(headers({ "cache-control": "max-age=abc" }), at)).toBe(at);
  });

  // A response that spent its whole lifetime in an intermediary arrives stale.
  test("subtracts the age the response already carries", () => {
    const stale = headers({ age: "40", "cache-control": "max-age=60" });
    expect(expiresAt(stale, at)).toBe(at + 20 * second);
  });

  test("clamps to now when the age exceeds the lifetime", () => {
    const spent = headers({ age: "600", "cache-control": "max-age=60" });
    expect(expiresAt(spent, at)).toBe(at);
  });

  test("falls back to Expires relative to Date", () => {
    const withExpires = headers({
      date: httpDate(at),
      expires: httpDate(at + 300 * second),
    });
    expect(expiresAt(withExpires, at)).toBe(at + 300 * second);
  });

  test("treats an Expires already past as stale", () => {
    const past = headers({
      date: httpDate(at),
      expires: httpDate(at - 300 * second),
    });
    expect(expiresAt(past, at)).toBe(at);
  });

  test("ignores an unparseable Expires", () => {
    expect(expiresAt(headers({ expires: "soon" }), at)).toBeUndefined();
  });

  test("max-age outranks Expires", () => {
    const both = headers({
      "cache-control": "max-age=60",
      date: httpDate(at),
      expires: httpDate(at + 86_400 * second),
    });
    expect(expiresAt(both, at)).toBe(at + 60 * second);
  });
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

  test("refuses a response that may not be shared", () => {
    const entry = cacheable(
      nativeResponse({ headers: headers({ "cache-control": "no-store" }) }),
      body,
      url,
    );
    expect(entry).toBeUndefined();
  });

  test("refuses a stale response with nothing to revalidate against", () => {
    const entry = cacheable(
      nativeResponse({ headers: headers({ "cache-control": "max-age=0" }) }),
      body,
      url,
    );
    expect(entry).toBeUndefined();
  });

  // Worth storing even though it is already stale: the validator turns the
  // next fetch into a conditional request that can return 304.
  test("stores an already-stale response carrying a validator", () => {
    const entry = cacheable(
      nativeResponse({
        headers: headers({ "cache-control": "max-age=0", etag: '"v1"' }),
      }),
      body,
      url,
    );
    expect(entry).toBeDefined();
  });

  test("accepts last-modified as a validator too", () => {
    const entry = cacheable(
      nativeResponse({
        headers: headers({ "last-modified": httpDate(at) }),
      }),
      body,
      url,
    );
    expect(entry).toBeDefined();
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

  test("keeps the stored body and status", () => {
    const next = refresh(stored, headers({ "cache-control": "max-age=60" }));
    expect(next.body).toBe(stored.body);
    expect(next.status).toBe(200);
  });

  test("overwrites stored headers the 304 restates", () => {
    const next = refresh(stored, headers({ etag: '"v2"' }));
    expect(new Headers(next.headers).get("etag")).toBe('"v2"');
  });

  // Otherwise the stored copy's original Age would keep counting against a
  // response the origin has just confirmed is current.
  test("drops a stored Age the 304 did not restate", () => {
    const next = refresh(stored, headers({ "cache-control": "max-age=60" }));
    expect(new Headers(next.headers).get("age")).toBeNull();
  });

  test("keeps an Age the 304 did restate", () => {
    const next = refresh(stored, headers({ age: "5" }));
    expect(new Headers(next.headers).get("age")).toBe("5");
  });

  // Same reason: the stored Date would make the refreshed entry look as old as
  // the response it replaced.
  test("stamps Date to now when the 304 omitted it", () => {
    const next = refresh(stored, headers({ "cache-control": "max-age=60" }));
    const stamped = Date.parse(new Headers(next.headers).get("date") ?? "");
    expect(Math.abs(stamped - Date.now())).toBeLessThan(5 * second);
  });

  test("recomputes expiry from the merged headers", () => {
    const next = refresh(stored, headers({ "cache-control": "max-age=60" }));
    expect(next.expiresAt).toBeGreaterThan(Date.now() + 55 * second);
  });
});
