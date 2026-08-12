import { describe, expect, test } from "bun:test";
import { validateParsedFeed } from "../src/lib/feed-parser.ts";
import {
  isMicroformatHtml,
  parseMicroformatFeed,
} from "../src/lib/microformat-feed-parser.ts";

const withFeedWrapper = `<!doctype html>
<html>
<body>
<div class="h-feed">
  <h1 class="p-name">My Blog</h1>
  <article class="h-entry">
    <h2 class="p-name"><a class="u-url" href="/post-1">First post</a></h2>
    <a class="p-author h-card" href="/">Author Name</a>
    <time class="dt-published" datetime="2026-07-22T10:00:00Z"></time>
    <div class="e-content">Hello <b>world</b></div>
  </article>
</div>
</body>
</html>`;

const withoutFeedWrapper = `<!doctype html>
<html>
<body>
<article class="h-entry">
  <h2 class="p-name"><a class="u-url" href="/loose-post">Loose post</a></h2>
  <time class="dt-published" datetime="2026-07-23T09:00:00Z"></time>
  <div class="e-content">No feed wrapper here</div>
</article>
</body>
</html>`;

const plainHtml = `<!doctype html><html><body><p>Just a regular page.</p></body></html>`;

describe("microformats HTML detection", () => {
  test("recognizes an HTML content-type or doctype", () => {
    expect(isMicroformatHtml(withFeedWrapper, "text/html; charset=utf-8")).toBe(
      true,
    );
    expect(isMicroformatHtml(withFeedWrapper, null)).toBe(true);
    expect(isMicroformatHtml('{"items":[]}', "application/json")).toBe(false);
  });
});

describe("microformats feed parsing", () => {
  test("maps h-entry items nested inside an h-feed", () => {
    const parsed = parseMicroformatFeed(
      withFeedWrapper,
      "https://example.com/",
    );
    expect(() => validateParsedFeed(parsed)).not.toThrow();
    expect(parsed.title).toBe("My Blog");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      authors: [{ name: "Author Name" }],
      content: "Hello <b>world</b>",
      title: "First post",
      url: "https://example.com/post-1",
    });
    expect(parsed.items[0]?.published).toEqual(
      new Date("2026-07-22T10:00:00Z"),
    );
  });

  test("falls back to top-level h-entry items with no h-feed wrapper", () => {
    const parsed = parseMicroformatFeed(
      withoutFeedWrapper,
      "https://example.com/",
    );
    expect(parsed.title).toBeNull();
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      title: "Loose post",
      url: "https://example.com/loose-post",
    });
  });

  test("rejects a page with no h-entry items", () => {
    expect(() =>
      parseMicroformatFeed(plainHtml, "https://example.com/"),
    ).toThrow("no microformats h-entry items");
  });
});
