import { describe, expect, test } from "bun:test";
import { mapFeedToPreview } from "#features/feeds/feed-mapper.ts";
import {
  decodeFeedBody,
  detectFeedEncoding,
  parseXmlFeed,
  validateParsedFeed,
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

const naadId =
  "tag:rss.naad-adna.pelmorex.com,2026-10-05:feed.atom/urn:oid:2.49.0.1.124.2313967115.2026";
const naad = () =>
  Bun.file(
    "src/features/feeds/__tests__/feed-parser-cases/naad-bilingual.xml",
  ).text();
const entriesOf = (text: string) => text.match(/<entry>.*?<\/entry>/gsu) ?? [];
// The feed with its entries replaced by the given ones.
const withEntries = (text: string, entries: string[]) =>
  text.replace(/<entry>.*<\/entry>/su, entries.join("\n"));
const articlesOf = (text: string) =>
  mapFeedToPreview(
    parseXmlFeed(text),
    "https://rss.naad-adna.pelmorex.com/",
    (content) => content,
    Date.parse("2026-10-06T08:06:42Z"),
  ).articles;
const guidsOf = (text: string) => articlesOf(text).map(({ guid }) => guid);
const capFeedGuids = (lang: string) =>
  guidsOf(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
    <entry xml:lang="${lang}"><id>x</id><category term="language=en"/></entry>
  </feed>`);

describe("entries sharing an id", () => {
  test("keeps every entry of a NAAD alert as its own article", async () => {
    const articles = articlesOf(await naad());
    expect(new Set(articles.map(({ guid }) => guid)).size).toBe(4);
    expect(articles.every(({ guid }) => guid.startsWith(`${naadId}#`))).toBe(
      true,
    );
    // NAAD entries carry no <published>.
    expect(articles.map(({ publishedAt }) => publishedAt)).toEqual(
      Array.from({ length: 4 }, () => new Date("2026-10-05T10:01:11Z")),
    );
  });

  test("keeps each entry's guid when its neighbours change", async () => {
    const text = await naad();
    const guids = guidsOf(text);
    const entries = entriesOf(text);
    expect(guidsOf(withEntries(text, entries.slice(2)))).toEqual(
      guids.slice(2),
    );
    expect(guidsOf(withEntries(text, entries.slice(2, 3)))).toEqual(
      guids.slice(2, 3),
    );
    expect(
      guidsOf(withEntries(text, [...entries.slice(2), ...entries.slice(0, 2)])),
    ).toEqual([...guids.slice(2), ...guids.slice(0, 2)]);
  });

  test("gives identical copies one guid, so they still collapse", async () => {
    const text = await naad();
    const first = entriesOf(text).slice(0, 1);
    expect(guidsOf(withEntries(text, [...first, ...first]))).toEqual([
      ...guidsOf(text).slice(0, 1),
      ...guidsOf(text).slice(0, 1),
    ]);
  });

  test("leaves the guids of a feed without the CAP namespace alone", () => {
    expect(
      guidsOf(`<feed xmlns="http://www.w3.org/2005/Atom">
        <entry xml:lang="en"><id>x</id><title>A</title></entry>
        <entry xml:lang="fr"><id>x</id><title>B</title></entry>
        <entry><id>y</id><category term="language=en"/></entry>
      </feed>`),
    ).toEqual(["x", "x", "y"]);
  });

  test("treats a feed that only mentions the CAP namespace as ordinary", () => {
    const [article] = articlesOf(`<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>post</id><title>CAP</title>
        <content type="html">&lt;cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"&gt;</content>
      </entry>
    </feed>`);
    expect(article?.guid).toBe("post");
  });

  test("treats a CAP namespace declared on an RSS item as CAP", () => {
    expect(
      guidsOf(`<rss><channel>
        <item xmlns:c="urn:oasis:names:tc:emergency:cap:1.1"><guid>x</guid><c:event>E</c:event></item>
      </channel></rss>`),
    ).not.toEqual(["x"]);
  });

  test("tells CAP entries apart by xml:lang before the language category", () => {
    expect(capFeedGuids("de")).not.toEqual(capFeedGuids("fr"));
  });
});
