import { describe, expect, test } from "bun:test";
import {
  buildNewsletterAddress,
  buildPreviewUrl,
  canonicalizeInstance,
  normalizeFeedAddress,
  resolveFeedOpenUrl,
} from "../url-helpers.ts";

describe("canonicalizeInstance", () => {
  test.each([
    ["https://example.com", "https://example.com"],
    ["https://EXAMPLE.com/", "https://example.com"],
    ["https://example.com:443", "https://example.com"],
    ["http://localhost:3456", "http://localhost:3456"],
    ["http://dev.localhost:3456/", "http://dev.localhost:3456"],
    ["http://127.0.0.2:3456", "http://127.0.0.2:3456"],
    ["http://[::1]:3456", "http://[::1]:3456"],
  ])("canonicalizes %s", (value, expected) => {
    expect(canonicalizeInstance(value)).toBe(expected);
  });

  test.each([
    "http://example.com:8080/",
    "ftp://example.com",
    "mailto:user@example.com",
    "https://user@example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/?query=value",
    "https://example.com/#fragment",
    "not a URL",
  ])("rejects %s", (value) => {
    expect(canonicalizeInstance(value)).toBeUndefined();
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

describe("buildPreviewUrl", () => {
  test("preserves the normalized feed address as one search parameter", () => {
    const address = "feed:https://example.com/feed?a=one&b=%25#section";
    const result = buildPreviewUrl("https://reader.example:8443", address);

    expect(result).toBeDefined();
    const previewUrl = new URL(result!);
    expect(previewUrl.origin).toBe("https://reader.example:8443");
    expect(previewUrl.pathname).toBe("/preview");
    expect(previewUrl.searchParams.get("feedUrl")).toBe(
      "https://example.com/feed?a=one&b=%25#section",
    );
    expect(previewUrl.hash).toBe("");
  });

  test("returns undefined for an invalid instance", () => {
    expect(
      buildPreviewUrl("https://example.com/path", "https://feed.test"),
    ).toBeUndefined();
  });
});

describe("buildNewsletterAddress", () => {
  test("uses the canonical hostname without the port", () => {
    expect(buildNewsletterAddress("https://example.com:8443", "01ABC")).toBe(
      "01ABC@example.com",
    );
  });

  test("prefers the instance's configured mail domain", () => {
    expect(
      buildNewsletterAddress("https://app.example.com", "01ABC", "mail.test"),
    ).toBe("01ABC@mail.test");
  });

  test("falls back to the hostname for a blank mail domain", () => {
    expect(buildNewsletterAddress("https://example.com", "01ABC", " ")).toBe(
      "01ABC@example.com",
    );
  });

  test("returns undefined for an invalid instance", () => {
    expect(buildNewsletterAddress("file:///tmp/feed", "01ABC")).toBeUndefined();
  });
});

describe("resolveFeedOpenUrl", () => {
  test("routes through the preview page when an instance is configured", () => {
    expect(
      resolveFeedOpenUrl("https://reader.example", "https://feed.test/rss"),
    ).toBe(
      "https://reader.example/preview?feedUrl=https%3A%2F%2Ffeed.test%2Frss",
    );
  });

  test("opens the feed address directly with no instance", () => {
    expect(resolveFeedOpenUrl(null, "feed://feed.test/rss")).toBe(
      "https://feed.test/rss",
    );
  });

  test("opens the feed address directly when the instance is invalid", () => {
    expect(resolveFeedOpenUrl("not a url", "https://feed.test/rss")).toBe(
      "https://feed.test/rss",
    );
  });
});
