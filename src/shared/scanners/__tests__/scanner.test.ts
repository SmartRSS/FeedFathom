import { describe, expect, test } from "bun:test";
import { scanHtml } from "#shared/scanners/scanner.ts";

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

  describe("GitHub releases", () => {
    const html = "<html><head><title>GitHub</title></head><body></body></html>";

    test.each([
      "https://github.com/SmartRSS/FeedFathom",
      "https://github.com/SmartRSS/FeedFathom/",
      "https://github.com/SmartRSS/FeedFathom/tree/staging/src/shared",
      "https://github.com/SmartRSS/FeedFathom/blob/staging/package.json",
      "https://github.com/SmartRSS/FeedFathom/issues/836",
      "https://github.com/SmartRSS/FeedFathom/releases/tag/v1.0",
      "https://github.com/SmartRSS/FeedFathom?tab=readme-ov-file",
      "https://github.com/SmartRSS/FeedFathom/#readme",
      "https://github.com/SmartRSS/FeedFathom/tree/staging?tab=readme-ov-file#readme",
      "http://github.com/SmartRSS/FeedFathom",
      "https://GITHUB.COM/SmartRSS/FeedFathom",
    ])("returns the canonical releases feed for %s", (address) => {
      expect(scanHtml(address, html)).toEqual([
        {
          title: "SmartRSS/FeedFathom - Releases",
          url: "https://github.com/SmartRSS/FeedFathom/releases.atom",
        },
      ]);
    });

    test("accepts repository names containing dots, underscores and hyphens", () => {
      expect(
        scanHtml("https://github.com/test-owner/repo_name.js-1/", html),
      ).toEqual([
        {
          title: "test-owner/repo_name.js-1 - Releases",
          url: "https://github.com/test-owner/repo_name.js-1/releases.atom",
        },
      ]);
    });

    test.each([
      "https://publisher.example/SmartRSS/FeedFathom",
      "https://githubXcom/SmartRSS/FeedFathom",
      "https://github.com.example/SmartRSS/FeedFathom",
      "https://gist.github.com/SmartRSS/FeedFathom",
      "https://github.com/",
      "https://github.com/SmartRSS",
      "https://github.com/SmartRSS/",
      "https://github.com/SmartRSS?tab=repositories#repositories",
      "https://github.com//FeedFathom",
      "https://github.com/SmartRSS//issues",
      "https://github.com/invalid_owner/FeedFathom",
      "https://github.com/SmartRSS/invalid%20repo",
      "https://github.com/SmartRSS/repo%2Fname",
      "https://github.com/settings/profile",
      "https://github.com/topics/rss",
      "https://github.com/collections/open-source",
      "https://github.com/trending/typescript",
      "https://github.com/orgs/SmartRSS/repositories",
      "https://github.com/users/SmartRSS/projects",
      "https://github.com/search/advanced?q=rss",
      "https://github.com/login/oauth/authorize",
      "https://github.com/features/actions",
      "https://github.com/marketplace/actions",
      "https://github.com/sponsors/SmartRSS",
      "https://github.com/notifications/subscriptions",
    ])("does not invent a GitHub releases feed for %s", (address) => {
      expect(
        scanHtml(address, html).filter((feed) =>
          feed.title.endsWith(" - Releases"),
        ),
      ).toEqual([]);
    });
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
