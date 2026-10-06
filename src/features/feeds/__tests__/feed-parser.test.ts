import { describe, expect, test } from "bun:test";
import { parseFeed } from "@rowanmanning/feed-parser";
import { mapFeedToPreview } from "#features/feeds/feed-mapper.ts";
import {
  decodeFeedBody,
  detectFeedEncoding,
  validateParsedFeed,
  withItemLanguages,
} from "#features/feeds/feed-parser.ts";

const item = {
  authors: [{ name: "Author" }],
  content: "Content",
  description: null,
  id: "article-1",
  published: new Date("2026-07-22T10:00:00.000Z"),
  title: "Article",
  updated: null,
  url: "https://example.com/article",
};
const feed = {
  description: "Description",
  items: [item],
  title: "Feed",
  url: "https://example.com/feed.xml",
};

describe("external feed parser projection", () => {
  test("accepts the fields consumed by feed mapping", () => {
    expect(() => validateParsedFeed(feed)).not.toThrow();
  });

  test("rejects malformed consumed fields without modeling unrelated parser data", () => {
    expect(() =>
      validateParsedFeed({ ...feed, items: [{ ...item, authors: "Author" }] }),
    ).toThrow("Feed parser returned an invalid feed projection");
    expect(() =>
      validateParsedFeed({
        ...feed,
        items: [{ ...item, published: "2026-07-22T10:00:00.000Z" }],
      }),
    ).toThrow("Feed parser returned an invalid feed projection");
    expect(() => validateParsedFeed({ ...feed, items: [{}] })).toThrow(
      "Feed parser returned an invalid feed projection",
    );
  });
});

describe("feed body encoding detection", () => {
  test("prefers a UTF-8 BOM over everything else", () => {
    const buffer = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x3f]).buffer;
    expect(detectFeedEncoding(buffer, "text/xml; charset=windows-1252")).toBe(
      "utf-8",
    );
  });

  test("prefers UTF-16 BOMs over the Content-Type header", () => {
    const le = new Uint8Array([0xff, 0xfe, 0x3c, 0x00]).buffer;
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x3c]).buffer;
    expect(detectFeedEncoding(le, "text/xml; charset=utf-8")).toBe("utf-16le");
    expect(detectFeedEncoding(be, "text/xml; charset=utf-8")).toBe("utf-16be");
  });

  test("falls back to the Content-Type charset when there's no BOM", () => {
    const buffer = new TextEncoder().encode("<rss></rss>").buffer;
    expect(detectFeedEncoding(buffer, "text/xml; charset=iso-8859-1")).toBe(
      "iso-8859-1",
    );
  });

  test.each([
    "application/rss+xml; charset=windows-1252",
    'application/rss+xml; charset="windows-1252"',
    'application/rss+xml; CHARSET="windows-1252" ; other=value',
  ])("decodes the declared HTTP charset: %s", (contentType) => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeFeedBody(bytes.buffer, contentType)).toBe("café");
  });

  test("falls back to the XML prolog's declared encoding", () => {
    const buffer = new TextEncoder().encode(
      '<?xml version="1.0" encoding="ISO-8859-1"?><rss></rss>',
    ).buffer;
    expect(detectFeedEncoding(buffer, null)).toBe("ISO-8859-1");
  });

  test("defaults to UTF-8 when nothing says otherwise", () => {
    const buffer = new TextEncoder().encode("<rss></rss>").buffer;
    expect(detectFeedEncoding(buffer, null)).toBe("utf-8");
  });

  test("decodes a Latin-1 body correctly instead of mojibake-ing it", () => {
    const xml =
      '<?xml version="1.0" encoding="ISO-8859-1"?><title>Caf\xe9</title>';
    const bytes = Uint8Array.from(xml, (char) => char.charCodeAt(0));
    expect(decodeFeedBody(bytes.buffer, null)).toContain("Café");
  });

  test("falls back to UTF-8 instead of throwing on a bogus encoding label", () => {
    const buffer = new TextEncoder().encode(
      '<?xml version="1.0" encoding="not-a-real-encoding"?><rss>ok</rss>',
    ).buffer;
    expect(() => decodeFeedBody(buffer, null)).not.toThrow();
    expect(decodeFeedBody(buffer, null)).toContain("ok");
  });
});

describe("entries sharing an id", () => {
  test("keeps every language of a NAAD alert as its own article", async () => {
    const text = await Bun.file(
      "src/features/feeds/__tests__/feed-parser-cases/naad-bilingual.xml",
    ).text();
    const preview = mapFeedToPreview(
      withItemLanguages(parseFeed(text)),
      "https://rss.naad-adna.pelmorex.com/",
      (content) => content,
      Date.parse("2026-10-06T08:06:42Z"),
    );
    const id =
      "tag:rss.naad-adna.pelmorex.com,2026-10-05:feed.atom/urn:oid:2.49.0.1.124.2313967115.2026";
    expect(
      preview.articles.map(({ guid, publishedAt, title }) => ({
        guid,
        publishedAt,
        title,
      })),
    ).toEqual(
      [
        { guid: `${id}#en-CA`, title: "squall watch in effect" },
        {
          guid: `${id}#fr-CA`,
          title: "veille de grains en vigueur en vigueur",
        },
        { guid: `${id}#en-CA#2`, title: "squall watch ended" },
        { guid: `${id}#fr-CA#2`, title: "veille de grains terminée" },
      ].map((article) =>
        Object.assign(article, {
          publishedAt: new Date("2026-10-05T10:01:11Z"),
        }),
      ),
    );
  });

  test("reads an entry's xml:lang before its language category", () => {
    const parsed = withItemLanguages(
      parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom">
        <entry xml:lang="de"><id>x</id><category term="language=en"/></entry>
        <entry><id>x</id></entry>
      </feed>`),
    );
    expect(parsed.items.map((entry) => entry.language)).toEqual([
      "de",
      undefined,
    ]);
  });
});
