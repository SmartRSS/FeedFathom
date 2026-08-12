import { describe, expect, test } from "bun:test";
import { scanHtml } from "../src/lib/scanner.ts";

describe("scanHtml", () => {
  test("discovers and resolves feeds from raw HTML", () => {
    expect(
      scanHtml(
        "https://publisher.example/articles/page",
        `<html><head>
          <base href="https://static.example/section/">
          <link type="application/rss+xml" href="../main.xml" title="Main feed">
          <meta name="generator" content="WordPress 6">
        </head><body><a href="/feeds/rss">Article feed</a></body></html>`,
      ),
    ).toEqual([
      { title: "Main feed", url: "https://static.example/main.xml" },
      { title: "Wordpress Feed", url: "https://publisher.example/feed" },
      {
        title: "Article feed",
        url: "https://publisher.example/feeds/rss",
      },
    ]);
  });

  test("recognizes a raw feed document", () => {
    expect(
      scanHtml(
        "https://publisher.example/feed.xml",
        '<rss version="2.0"><channel><title>Feed</title></channel></rss>',
      ),
    ).toContainEqual({
      title: "This feed",
      url: "https://publisher.example/feed.xml",
    });
  });

  test("discovers a JSON Feed advertised via link autodiscovery", () => {
    expect(
      scanHtml(
        "https://publisher.example/",
        '<html><head><link rel="alternate" type="application/feed+json" href="/feed.json" title="JSON feed"></head><body></body></html>',
      ),
    ).toContainEqual({
      title: "JSON feed",
      url: "https://publisher.example/feed.json",
    });
  });

  test("offers the page itself when it has microformats h-entry markup", () => {
    expect(
      scanHtml(
        "https://blog.example/",
        '<html><body><article class="h-entry"><span class="p-name">Post</span></article></body></html>',
      ),
    ).toContainEqual({
      title: "This page (h-entry)",
      url: "https://blog.example/",
    });
  });

  test("does not offer a microformats subscription for an ordinary page", () => {
    const results = scanHtml(
      "https://publisher.example/about",
      "<html><body><p>Just a regular page.</p></body></html>",
    );
    expect(
      results.some((result) => result.title === "This page (h-entry)"),
    ).toBe(false);
  });
});
