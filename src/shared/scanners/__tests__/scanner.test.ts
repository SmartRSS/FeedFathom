import { describe, expect, test } from "bun:test";
import type { ScannerPage } from "../scanner-page.ts";
import { openRssSuggestion, scanPage } from "../scanner.ts";

const emptyPage: ScannerPage = {
  anchors: [],
  baseUrl: "",
  feedLinks: [],
  hasMicroformatEntries: false,
  rootName: "html",
};

const scan = (address: string, page: Partial<ScannerPage> = {}) =>
  scanPage(address, { ...emptyPage, baseUrl: address, ...page });

test("the OpenRSS suggestion names the page without its scheme", () => {
  expect(openRssSuggestion("https://site.example/blog?page=2")).toEqual({
    title: "Attempt to use OpenRSS",
    url: "https://openrss.org/site.example/blog?page=2",
  });
});

test("resolves head links against the base, and drops repeats", () => {
  expect(
    scan("https://publisher.example/post", {
      baseUrl: "https://static.example/a/",
      feedLinks: [
        { href: "../main.xml", title: "Main" },
        { href: "/untitled.xml" },
        { href: "http://[" },
        { href: "https://static.example/main.xml", title: "Again" },
      ],
    }),
  ).toEqual([
    { title: "Main", url: "https://static.example/main.xml" },
    {
      title: "https://static.example/untitled.xml",
      url: "https://static.example/untitled.xml",
    },
  ]);
});

test.each(["rss", "feed", "channel", "rdf:rdf"])(
  "offers a raw <%s> feed document itself",
  (rootName) => {
    expect(
      scan("https://publisher.example/feed.xml", {
        rootName,
        rootXmlns: "http://purl.org/rss/1.0/",
      }),
    ).toEqual([
      { title: "This feed", url: "https://publisher.example/feed.xml" },
    ]);
  },
);

test("offers a WordPress site's feed by its generator", () => {
  expect(
    scan("https://blog.example/post", { generator: "WordPress 6.5" }),
  ).toEqual([{ title: "Wordpress Feed", url: "https://blog.example/feed" }]);
});

test("offers same-host anchors whose path looks like a feed", () => {
  expect(
    scan("https://blog.example/", {
      anchors: [
        { href: "/feeds/rss", text: " Posts " },
        { href: "/feed", text: "" },
        { href: "https://other.example/feed", text: "Elsewhere" },
        { href: "/about", text: "About" },
        { href: "http://[", text: "Broken" },
      ],
    }),
  ).toEqual([
    { title: "Posts", url: "https://blog.example/feeds/rss" },
    { title: "Untitled Feed", url: "https://blog.example/feed" },
  ]);
});

test.each([
  ["https://blog.example/archive/", ["https://blog.example/archive/feed"]],
  ["https://static.example/", []],
])("resolves anchors against the base %s", (baseUrl, expected) => {
  const feeds = scan("https://blog.example/post/1", {
    anchors: [{ href: "feed", text: "Feed" }],
    baseUrl,
  });
  expect(feeds.map((feed) => feed.url)).toEqual(expected);
});

test("offers the page itself when it has microformats entries", () => {
  expect(
    scan("https://blog.example/", { hasMicroformatEntries: true }),
  ).toEqual([{ title: "This page (h-entry)", url: "https://blog.example/" }]);
});

describe("site rules", () => {
  test.each([
    [
      "https://www.youtube.com/channel/abc",
      {},
      "https://www.youtube.com/feeds/videos.xml?channel_id=abc",
    ],
    [
      "https://m.youtube.com/watch?v=x",
      { youtubeChannelHref: "https://www.youtube.com/channel/abc" },
      "https://www.youtube.com/feeds/videos.xml?channel_id=abc",
    ],
    ["https://vimeo.com/someone", {}, "https://vimeo.com/someone/videos/rss/"],
    [
      "https://vimeo.com/123456",
      { vimeoChannelHref: "/someone" },
      "https://vimeo.com/someone/videos/rss/",
    ],
    [
      "https://odysee.com/@channel:1/video:2",
      {},
      "https://lbryfeed.melroy.org/channel/channel",
    ],
    [
      "https://www.bitchute.com/video/x/",
      { bitchuteChannelName: "someone" },
      "https://www.bitchute.com/feeds/rss/channel/someone",
    ],
    ["https://hive.blog/@user?x=1#c", {}, "https://www.hiverss.com/@user/feed"],
    ["https://steemit.com/@user", {}, "https://www.hiverss.com/@user/feed"],
    [
      "https://github.com/SmartRSS/FeedFathom/tree/main?tab=readme#readme",
      {},
      "https://github.com/SmartRSS/FeedFathom/releases.atom",
    ],
  ])("%s yields its site feed", (address, page, url) => {
    expect(scan(address, page).map((feed) => feed.url)).toEqual([url]);
  });

  test.each([
    "https://vimeo.com/123456",
    "https://evilhive.blog/@user",
    "https://notyoutube.com/channel/abc",
    "https://github.com.example/SmartRSS/FeedFathom",
    "https://github.com/SmartRSS",
    "https://github.com/settings/profile",
    "https://hive.blog/",
  ])("%s yields nothing", (address) => {
    expect(scan(address)).toEqual([]);
  });
});
