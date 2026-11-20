import { expect, test } from "bun:test";
import type { OpmlNode } from "#features/feeds/opml-types.ts";
import { buildOpml } from "#features/feeds/opml-export.ts";
import { parseOpml } from "#features/feeds/opml-parser.ts";

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

  expect(parseOpml(buildOpml("Subscriptions", tree))).toEqual(tree);
});

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
  expect(parseOpml(opml)).toHaveLength(1);
});

test("drops a lone surrogate without dropping a real astral character", () => {
  const opml = buildOpml("Subscriptions", [
    {
      homeUrl: "https://x.test",
      name: `Half${String.fromCharCode(0xd800)} pair, whole 😀`,
      type: "source",
      xmlUrl: "https://x.test/feed",
    },
  ]);

  expect(parseOpml(opml)).toEqual([
    {
      homeUrl: "https://x.test",
      name: "Half pair, whole 😀",
      type: "source",
      xmlUrl: "https://x.test/feed",
    },
  ]);
});

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

  expect(parseOpml(opml)).toEqual([
    {
      homeUrl: "https://x.test",
      name: "Bell and null",
      type: "source",
      xmlUrl: "https://x.test/feed",
    },
  ]);
});
