import { expect, test } from "bun:test";
import type { OpmlNode } from "#shared/types/opml-types.ts";
import { buildOpml } from "#features/feeds/opml-export.ts";
import { OpmlParser } from "#features/feeds/opml-parser.ts";

const parser = new OpmlParser();

// An export is only worth anything if it goes back in, here or anywhere else,
// so the parser this repo already has is the oracle.
test("a tree survives the round trip through OPML", () => {
  const tree: OpmlNode[] = [
    {
      children: [
        {
          homeUrl: "https://news.test",
          name: "Tom & Jerry <weekly>",
          type: "source",
          xmlUrl: "https://news.test/feed?a=1&b=2",
        },
      ],
      name: "News",
      type: "folder",
    },
    { children: [], name: "Empty", type: "folder" },
    {
      homeUrl: "https://blog.test",
      name: 'He said "hi"',
      type: "source",
      xmlUrl: "https://blog.test/rss",
    },
  ];

  expect(parser.parseOpml(buildOpml("Subscriptions", tree))).toEqual(tree);
});

// An ampersand or an angle bracket in a title is the ordinary case, not the
// exotic one -- concatenating them into the document unescaped produces a
// file no conforming parser will open.
test("escapes markup in titles rather than emitting it", () => {
  const opml = buildOpml("A & B", [
    {
      homeUrl: "https://x.test",
      name: "<script>",
      type: "source",
      xmlUrl: "https://x.test/feed",
    },
  ]);

  expect(opml).toContain("&lt;script&gt;");
  expect(opml).not.toContain("<script>");
  expect(parser.parseOpml(opml)).toHaveLength(1);
});

// Bun.XML.stringify throws on these rather than escaping them, so an export
// would fail outright over one bad byte in one title.
test("drops a lone surrogate without dropping a real astral character", () => {
  const opml = buildOpml("Subscriptions", [
    {
      homeUrl: "https://x.test",
      name: `Half${String.fromCharCode(0xd800)} pair, whole 😀`,
      type: "source",
      xmlUrl: "https://x.test/feed",
    },
  ]);

  expect(parser.parseOpml(opml)).toEqual([
    {
      homeUrl: "https://x.test",
      name: "Half pair, whole 😀",
      type: "source",
      xmlUrl: "https://x.test/feed",
    },
  ]);
});

// XML 1.0 has no escape for most control characters, so a title carrying one
// would otherwise make the whole file unparseable.
test("drops control characters a title picked up from a feed", () => {
  const name = `Bell${String.fromCodePoint(7)} and null${String.fromCodePoint(0)}`;
  const opml = buildOpml("Subscriptions", [
    {
      homeUrl: "https://x.test",
      name,
      type: "source",
      xmlUrl: "https://x.test/feed",
    },
  ]);

  expect(parser.parseOpml(opml)).toEqual([
    {
      homeUrl: "https://x.test",
      name: "Bell and null",
      type: "source",
      xmlUrl: "https://x.test/feed",
    },
  ]);
});
