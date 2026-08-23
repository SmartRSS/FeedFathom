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

// Both shapes are taken from feeds that really are served as text/html:
// chollinger.com/blog/index.xml (Hugo) and cert.orange.pl/feed/ (WordPress).
const rssServedAsHtml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Christian Hollinger</title></channel></rss>`;
const atomServedAsHtml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title></feed>`;
const rdfFeed = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>`;
// XHTML opens with an XML declaration too, so the declaration alone must not
// be what disqualifies a document from the microformats path.
const xhtmlWithEntry = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
<article class="h-entry">
  <h2 class="p-name"><a class="u-url" href="/xhtml-post">XHTML post</a></h2>
</article>
</body>
</html>`;

describe("microformats HTML detection", () => {
  test("recognizes an HTML content-type or doctype", () => {
    expect(isMicroformatHtml(withFeedWrapper, "text/html; charset=utf-8")).toBe(
      true,
    );
    expect(isMicroformatHtml(withFeedWrapper, null)).toBe(true);
    expect(isMicroformatHtml('{"items":[]}', "application/json")).toBe(false);
  });

  test("lets a feed root outrank a text/html content-type", () => {
    expect(isMicroformatHtml(rssServedAsHtml, "text/html; charset=UTF-8")).toBe(
      false,
    );
    expect(isMicroformatHtml(atomServedAsHtml, "text/html")).toBe(false);
    expect(isMicroformatHtml(rdfFeed, "text/html")).toBe(false);
  });

  test("still treats XHTML carrying microformats as HTML", () => {
    expect(isMicroformatHtml(xhtmlWithEntry, "text/html; charset=utf-8")).toBe(
      true,
    );
    expect(
      parseMicroformatFeed(xhtmlWithEntry, "https://example.com/").items,
    ).toHaveLength(1);
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
