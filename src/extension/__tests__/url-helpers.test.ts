import { describe, expect, test } from "bun:test";
import {
  canonicalizeInstance,
  normalizeFeedAddress,
  targetUrl,
} from "../url-helpers.ts";

// The rule itself is secureOrigin's, tested in safe-url.test.ts.
describe("canonicalizeInstance", () => {
  test("keeps a secure origin in its canonical form", () => {
    expect<string | undefined>(
      canonicalizeInstance("https://EXAMPLE.com/"),
    ).toBe("https://example.com");
  });

  test("refuses anything secureOrigin refuses", () => {
    expect(canonicalizeInstance("http://example.com")).toBeUndefined();
    expect(canonicalizeInstance("https://example.com/path")).toBeUndefined();
  });
});

describe("normalizeFeedAddress", () => {
  test.each([
    [
      "feed://example.com/path?x=a&y=%25#section",
      "https://example.com/path?x=a&y=%25#section",
    ],
    [
      "feed:https://example.com/path?x=a&y=%25#section",
      "https://example.com/path?x=a&y=%25#section",
    ],
    ["feed:http://example.com/feed", "http://example.com/feed"],
  ])("normalizes %s", (address, expected) => {
    expect(normalizeFeedAddress(address)).toBe(expected);
  });

  test.each([
    "https://example.com/path?x=a&y=%25#section",
    "http://example.com/feed",
    "reader@example.com",
    "special & # % value",
  ])("leaves %s unchanged", (address) => {
    expect(normalizeFeedAddress(address)).toBe(address);
  });
});

const instance = canonicalizeInstance("https://reader.example:8443");
if (!instance) throw new Error("test instance must be canonical");

describe("targetUrl", () => {
  test("previews a feed on the instance, as one search parameter", () => {
    const result = targetUrl(
      { feedUrl: "feed:https://example.com/feed?a=one&b=%25#section" },
      instance,
    );

    const previewUrl = new URL(result ?? "");
    expect(previewUrl.origin).toBe("https://reader.example:8443");
    expect(previewUrl.pathname).toBe("/preview");
    expect(previewUrl.searchParams.get("feedUrl")).toBe(
      "https://example.com/feed?a=one&b=%25#section",
    );
    expect(previewUrl.hash).toBe("");
  });

  test("opens the feed address directly with no instance", () => {
    expect(targetUrl({ feedUrl: "feed://feed.test/rss" }, null)).toBe(
      "https://feed.test/rss",
    );
  });

  test("opens the instance's preview page in newsletter mode", () => {
    expect(targetUrl("newsletter", instance)).toBe(
      "https://reader.example:8443/preview?newsletter",
    );
  });

  test("opens the dashboard at the instance origin", () => {
    expect(targetUrl("dashboard", instance)).toBe(
      "https://reader.example:8443",
    );
  });

  test.each(["dashboard", "newsletter"] as const)(
    "has nowhere to open %s with no instance",
    (target) => {
      expect(targetUrl(target, null)).toBeUndefined();
    },
  );
});
