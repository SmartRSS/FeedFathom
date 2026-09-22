import { describe, expect, test } from "bun:test";
import { validateParsedFeed } from "#features/feeds/feed-parser.ts";
import {
  isJsonFeedText,
  parseJsonFeed,
} from "#features/feeds/json-feed-parser.ts";
import { extractArticle } from "#features/feeds/extract-article.ts";
import { mapFeedToPreview } from "#features/feeds/feed-mapper.ts";
import { rewriteLinks } from "#features/feeds/rewrite-links.ts";

const feedText = JSON.stringify({
  description: "About the feed",
  feed_url: "https://example.com/feed.json",
  home_page_url: "https://example.com/",
  items: [
    {
      authors: [{ name: "Author" }],
      content_html: "<p>Content</p>",
      date_published: "2026-07-22T10:00:00.000Z",
      id: "article-1",
      title: "Article",
      url: "https://example.com/article",
    },
    {
      author: { name: "Legacy author" },
      content_text: "Plain text body",
      id: "article-2",
      summary: "A summary",
    },
  ],
  title: "Feed",
});

describe("JSON Feed detection", () => {
  test("recognizes JSON documents and rejects XML ones", () => {
    expect(isJsonFeedText(feedText)).toBe(true);
    expect(isJsonFeedText(' \n {"items":[]}')).toBe(true);
    expect(isJsonFeedText('<?xml version="1.0"?><rss></rss>')).toBe(false);
  });
});

describe("JSON Feed parsing", () => {
  test("maps fields onto the shared feed projection", () => {
    const parsed = parseJsonFeed(feedText);
    expect(() => validateParsedFeed(parsed)).not.toThrow();
    expect(parsed.title).toBe("Feed");
    expect(parsed.url).toBe("https://example.com/");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      authors: [{ name: "Author" }],
      content: "<p>Content</p>",
      id: "article-1",
      title: "Article",
      url: "https://example.com/article",
    });
    expect(parsed.items[0]?.published).toEqual(
      new Date("2026-07-22T10:00:00.000Z"),
    );
  });

  test("falls back to the legacy single-author field and content_text", () => {
    const parsed = parseJsonFeed(feedText);
    expect(parsed.items[1]).toMatchObject({
      authors: [{ name: "Legacy author" }],
      content: "Plain text body",
      description: "A summary",
      id: "article-2",
    });
  });

  test("rejects documents without an items array", () => {
    expect(() => parseJsonFeed(JSON.stringify({ title: "No items" }))).toThrow(
      "The JSON document could not be parsed as a feed",
    );
  });

  test("rejects malformed JSON", () => {
    expect(() => parseJsonFeed("{not json")).toThrow();
  });
});

describe("JSON Feed plain text", () => {
  const text = 'a < b && c > d\n&amp; is not "&"\r\n<b>not bold</b>';
  const html =
    'a &lt; b &amp;&amp; c &gt; d<br />&amp;amp; is not "&amp;"<br />&lt;b&gt;not bold&lt;/b&gt;';

  const previewContent = (item: Record<string, string>) => {
    const parsed = parseJsonFeed(
      JSON.stringify({ items: [{ id: "1", ...item }] }),
    );
    const preview = mapFeedToPreview(
      parsed,
      "https://example.com/feed.json",
      rewriteLinks,
    );
    return extractArticle(preview.articles[0]?.content);
  };

  test("renders content_text literally with its line breaks", () => {
    expect(previewContent({ content_text: text })).toBe(html);
  });

  test("renders a plain-text summary fallback literally", () => {
    expect(previewContent({ summary: text })).toBe(html);
  });

  test("content_html keeps its formatting and wins over plain text", () => {
    expect(
      previewContent({
        content_html: "<p><strong>bold</strong></p>",
        content_text: text,
        summary: text,
      }),
    ).toBe("<p><strong>bold</strong></p>");
  });
});
