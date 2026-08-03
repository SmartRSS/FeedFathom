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
});
