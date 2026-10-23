import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseFeed } from "@rowanmanning/feed-parser";
import {
  mapFeedItemToArticle,
  mapFeedToPreview,
} from "#features/feeds/feed-mapper.ts";
import { rewriteLinks } from "#features/feeds/rewrite-links.ts";
import {
  decodeFeedBody,
  detectFeedEncoding,
  parseXmlFeed,
  validateParsedFeed,
} from "#features/feeds/feed-parser.ts";
import { parseJsonFeed } from "#features/feeds/json-feed-parser.ts";
import { parseMicroformatFeed } from "#features/feeds/microformat-feed-parser.ts";

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
  test("rejects declared entities before the XML parser can expand them", () => {
    expect(() =>
      parseXmlFeed(`<!DOCTYPE rss [<!ENTITY payload "expanded">]>
        <rss version="2.0"><channel><title>&payload;</title></channel></rss>`),
    ).toThrow("XML entity declarations are not allowed");
  });

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

// Feed bodies as they arrive on the wire. Markup is ASCII, so a string part is
// one byte per char; non-ASCII text is always a literal byte array, never a JS
// string, which would already be decoded.
const asciiCodes = (text: string) =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const fromParts = (...parts: (string | number[])[]) =>
  parts.flatMap((part) => (typeof part === "string" ? asciiCodes(part) : part));
const utf16le = (text: string) => asciiCodes(text).flatMap((code) => [code, 0]);
const rss = (title: number[], head: string | number[] = "") =>
  fromParts(
    head,
    '<rss version="2.0"><channel><title>',
    title,
    "</title><link>https://example.com/</link></channel></rss>",
  );
const titleOf = (body: number[], contentType: string | null) =>
  parseXmlFeed(decodeFeedBody(Uint8Array.from(body).buffer, contentType)).title;

const zazolc = [0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6]; // "Zażółć" in ISO-8859-2
const nihongo = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]; // "日本語" in Shift_JIS
const cafe = [0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35]; // "Café €5" in windows-1252
const zazolcUtf8 = [0x5a, 0x61, 0xc5, 0xbc, 0xc3, 0xb3, 0xc5, 0x82, 0xc4, 0x87]; // "Zażółć" in UTF-8
const zazolcUtf16le = [
  0x5a, 0x00, 0x61, 0x00, 0x7c, 0x01, 0xf3, 0x00, 0x42, 0x01, 0x07, 0x01,
]; // "Zażółć" in UTF-16LE

describe("decoded feed titles from encoded bytes", () => {
  test.each([
    ["ISO-8859-2", zazolc, "Zażółć"],
    ["Shift_JIS", nihongo, "日本語"],
    ["windows-1252", cafe, "Café €5"],
  ])("decodes %s from the HTTP charset", (label, title, expected) => {
    expect(titleOf(rss(title), `text/xml; charset=${label}`)).toBe(expected);
  });

  test.each([
    ["ISO-8859-2", zazolc, "Zażółć"],
    ["Shift_JIS", nihongo, "日本語"],
    ["windows-1252", cafe, "Café €5"],
  ])(
    "decodes %s from the XML prolog when there is no HTTP charset",
    (label, title, expected) => {
      const head = `<?xml version="1.0" encoding="${label}"?>`;
      expect(titleOf(rss(title, head), "text/xml")).toBe(expected);
      expect(titleOf(rss(title, head), null)).toBe(expected);
    },
  );

  test("HTTP charset wins when the prolog names another encoding", () => {
    const head = '<?xml version="1.0" encoding="ISO-8859-2"?>';
    expect(titleOf(rss(cafe, head), "text/xml; charset=windows-1252")).toBe(
      "Café €5",
    );
  });

  test("HTTP charset wins over a Shift_JIS prolog", () => {
    const head = '<?xml version="1.0" encoding="Shift_JIS"?>';
    expect(titleOf(rss(zazolc, head), "text/xml; charset=ISO-8859-2")).toBe(
      "Zażółć",
    );
  });

  test("UTF-8 BOM beats an HTTP charset and a prolog that both disagree", () => {
    const head = '<?xml version="1.0" encoding="Shift_JIS"?>';
    const body = [0xef, 0xbb, 0xbf, ...rss(zazolcUtf8, head)];
    expect(titleOf(body, "text/xml; charset=windows-1252")).toBe("Zażółć");
  });

  test("UTF-16LE BOM beats an HTTP charset and a prolog that both disagree", () => {
    const head = utf16le('<?xml version="1.0" encoding="ISO-8859-2"?>');
    const body = [
      0xff,
      0xfe,
      ...head,
      ...utf16le('<rss version="2.0"><channel><title>'),
      ...zazolcUtf16le,
      ...utf16le("</title></channel></rss>"),
    ];
    expect(titleOf(body, "text/xml; charset=windows-1252")).toBe("Zażółć");
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

test("resolves relative entry links against a redirected feed URL", async () => {
  const parsedFixtureFeed = parseXmlFeed(
    await Bun.file(
      "src/features/feeds/__tests__/feed-parser-cases/relative-links-after-redirect.xml",
    ).text(),
  );
  const preview = mapFeedToPreview(
    parsedFixtureFeed,
    "https://publisher.example/old/feed.xml",
    rewriteLinks,
    Date.parse("2026-10-14T00:00:00Z"),
    "https://cdn.example/new/path/feed.xml",
  );

  expect(preview.articles[0]?.url).toBe(
    "https://cdn.example/new/path/articles/one",
  );
  expect(preview.articles[0]?.content).toContain(
    'href="https://cdn.example/new/path/articles/images/cover.png"',
  );
});

// Each read of a feed-level fallback scans every child of the channel, so one
// read per item made a 20 MiB preview take minutes (#1031).
test.each([
  [
    "RSS",
    `<rss><channel><link>https://example.com/</link>${"<item><link>a</link></item>".repeat(3)}</channel></rss>`,
  ],
  [
    "Atom",
    `<feed xmlns="http://www.w3.org/2005/Atom"><link href="https://example.com/"/>${'<entry><link href="a"/></entry>'.repeat(3)}</feed>`,
  ],
])(
  "reads an %s feed's own url, authors and categories once, not per item",
  (_, text) => {
    const prototype: object = Object.getPrototypeOf(parseFeed(text));
    const reads = { authors: 0, categories: 0, url: 0 };
    const keys = ["authors", "categories", "url"] as const;
    const originals = keys.map((key) => {
      const original = Object.getOwnPropertyDescriptor(prototype, key);
      Object.defineProperty(prototype, key, {
        configurable: true,
        get(this: object) {
          reads[key]++;
          return original?.get?.call(this);
        },
      });
      return [key, original] as const;
    });
    try {
      const parsed = parseXmlFeed(text);
      expect(parsed.items).toHaveLength(3);
      for (const entry of parsed.items) {
        expect(entry.url).toBe("https://example.com/a");
        expect(entry.authors).toEqual([]);
        expect(entry.categories).toEqual([]);
      }
      expect(reads).toEqual({ authors: 1, categories: 1, url: 1 });
    } finally {
      for (const [key, original] of originals) {
        if (original) Object.defineProperty(prototype, key, original);
      }
    }
  },
);

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

const fixture = (name: string) =>
  Bun.file(`src/features/feeds/__tests__/feed-parser-cases/${name}`).text();

describe("feed dates", () => {
  // Under UTC a zoneless date reads the same either way, so pin a zone that
  // tells local time and UTC apart.
  const hostZone = process.env["TZ"];
  beforeAll(() => {
    process.env["TZ"] = "America/New_York";
  });
  afterAll(() => {
    if (hostZone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = hostZone;
  });

  const ingestedAt = Date.parse("2026-10-14T00:00:00Z");
  // Each fixture entry's title is the instant its date names.
  const expectTitledInstants = (
    parsed: Parameters<typeof mapFeedToPreview>[0],
  ) =>
    expect(
      mapFeedToPreview(parsed, "https://example.com/", rewriteLinks, ingestedAt)
        .articles.map(({ guid, publishedAt, title }) => [
          guid,
          publishedAt.toISOString(),
          title === "ingest" ? new Date(ingestedAt).toISOString() : title,
        ])
        .filter(([, actual, expected]) => actual !== expected),
    ).toEqual([]);

  test("reads RSS dates in every zone spelling, falling back only when unparseable", async () => {
    expectTitledInstants(parseXmlFeed(await fixture("date-zones.xml")));
  });

  test("reads zoneless Atom dates as UTC", async () => {
    const parsed = parseXmlFeed(await fixture("date-zones-atom.xml"));
    expectTitledInstants(parsed);
    expect(parsed.items[0]?.updated?.toISOString()).toBe(
      "2003-06-11T04:00:00.000Z",
    );
  });

  test("reads zoneless JSON Feed dates as UTC", () => {
    const [entry] = parseJsonFeed(
      JSON.stringify({
        items: [{ date_published: "2003-06-10T04:00:00", id: "a" }],
      }),
    ).items;
    expect(entry?.published?.toISOString()).toBe("2003-06-10T04:00:00.000Z");
  });

  test("reads zoneless microformat dates as UTC and drops unparseable ones", () => {
    const [entry, unparseable] = parseMicroformatFeed(
      `<!doctype html><html><body>
        <article class="h-entry"><time class="dt-published" datetime="2003-06-10 04:00"></time></article>
        <article class="h-entry"><time class="dt-published" datetime="soon"></time></article>
      </body></html>`,
      "https://example.com/",
    ).items;
    expect(entry?.published?.toISOString()).toBe("2003-06-10T04:00:00.000Z");
    expect(unparseable?.published).toBeNull();
  });
});

const enclosuresOf = (parsed: ReturnType<typeof parseJsonFeed>) =>
  mapFeedItemToArticle(
    parsed.items[0]!,
    parsed,
    { id: 1, url: "https://example.com/feed" },
    (content) => content,
  ).enclosures;

describe("enclosures", () => {
  test("keeps YouTube's media:group video and thumbnail", () => {
    const parsed =
      parseXmlFeed(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
      <entry><id>yt:video:dQw4w9WgXcQ</id><title>Video</title>
        <link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
        <media:group>
          <media:title>Video</media:title>
          <media:content url="https://www.youtube.com/v/dQw4w9WgXcQ?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
          <media:thumbnail url="https://i1.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480" height="360"/>
        </media:group>
      </entry></feed>`);
    expect(enclosuresOf(parsed)).toEqual([
      {
        medium: "other",
        mimeType: "application/x-shockwave-flash",
        thumbnail: "https://i1.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        title: "Video",
        url: "https://www.youtube.com/v/dQw4w9WgXcQ?version=3",
      },
    ]);
  });

  test("uses a YouTube video's media:description as its body", () => {
    const parsed =
      parseXmlFeed(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
      <entry><id>a</id><media:group><media:description>Line one &lt;b&gt;
Line two</media:description></media:group></entry>
      <entry><id>b</id><summary>Own summary</summary><media:group><media:description>Ignored</media:description></media:group></entry>
    </feed>`);
    expect(parsed.items.map((entry) => entry.description)).toEqual([
      "Line one &lt;b&gt;<br>Line two",
      "Own summary",
    ]);
  });

  test("keeps a podcast episode and drops unsafe or extra URLs", () => {
    const items = [
      '<enclosure url="/episodes/1.mp3" type="audio/mpeg" length="1"/>',
      '<media:content url="javascript:alert(1)" medium="image"/>',
      ...Array.from(
        { length: 30 },
        (_, index) => `<media:content url="/img/${index}.png" medium="image"/>`,
      ),
    ].join("");
    const parsed = parseXmlFeed(
      `<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><link>https://pod.example/</link><item><link>https://pod.example/1</link>${items}</item></channel></rss>`,
    );
    const enclosures = enclosuresOf(parsed);
    expect(enclosures[0]).toEqual({
      medium: "audio",
      mimeType: "audio/mpeg",
      thumbnail: null,
      title: null,
      url: "https://pod.example/episodes/1.mp3",
    });
    expect(enclosures).toHaveLength(20);
    expect(enclosures.every(({ url }) => url.startsWith("https:"))).toBe(true);
  });

  test("reads JSON Feed attachments", () => {
    const parsed = parseJsonFeed(
      JSON.stringify({
        items: [
          {
            attachments: [
              {
                mime_type: "Video/MP4",
                title: "Clip",
                url: "https://e.x/a.mp4",
              },
              { title: "no url" },
            ],
            id: "1",
          },
        ],
      }),
    );
    expect(enclosuresOf(parsed)).toEqual([
      {
        medium: "video",
        mimeType: "video/mp4",
        thumbnail: null,
        title: "Clip",
        url: "https://e.x/a.mp4",
      },
    ]);
  });
});
