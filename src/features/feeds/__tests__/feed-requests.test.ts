import type { ArticleImporter } from "#features/feeds/article-import.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";
import { expect, test } from "bun:test";
import { loopbackWorkerRequests } from "#platform/__tests__/loopback-worker-requests.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import {
  createFeedRequestHandlers,
  type FeedRequestHandlerServices,
  FeedRequests,
} from "#features/feeds/feed-requests.ts";
import {
  mapFeedToPreview,
  previewArticleLimit,
} from "#features/feeds/feed-mapper.ts";
import { serializeFeedPreview } from "#features/feeds/feed-preview-cache.ts";
import { extractArticle } from "#features/feeds/extract-article.ts";

const page = "https://site.example/";

const requestsFor = (services: Partial<FeedRequestHandlerServices>) =>
  new FeedRequests(
    loopbackWorkerRequests(
      () =>
        new Map(
          createFeedRequestHandlers({
            articleImporter: strictFake<ArticleImporter>({}, "articleImporter"),
            feedParser: strictFake<FeedParser>({}, "feedParser"),
            feedPreviewCache: strictFake<FeedPreviewCache>(
              {},
              "feedPreviewCache",
            ),
            httpClient: strictFake<FeedRequestHandlerServices["httpClient"]>(
              {},
              "httpClient",
            ),
            ...services,
          }),
        ),
    ),
  );

const find = async (body: Uint8Array<ArrayBuffer>, contentType: string) => {
  const probed: string[] = [];
  const reply = await requestsFor({
    feedParser: strictFake<FeedParser>({
      parseUrl: async (url) => {
        probed.push(url);
        throw new Error("not a feed");
      },
    }),
    httpClient: {
      get: async (url) => ({
        data: body.buffer,
        headers: new Headers({ "content-type": contentType }),
        url,
      }),
    },
  }).find(page);
  return { found: "feeds" in reply ? reply.feeds : reply, probed };
};

const novosti = [0xcd, 0xee, 0xe2, 0xee, 0xf1, 0xf2, 0xe8];
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

test("find reads feed titles in the page's own charset", async () => {
  const html = Uint8Array.from([
    ...ascii(
      '<html><head><link type="application/rss+xml" href="/rss" title="',
    ),
    ...novosti,
    ...ascii('"></head></html>'),
  ]);

  const { found } = await find(html, "text/html; charset=windows-1251");

  expect(found).toEqual([
    { title: "Новости", url: "https://site.example/rss", websub: false },
  ]);
});

test("find suggests OpenRSS for a page with no feeds without contacting it", async () => {
  const { found, probed } = await find(
    Uint8Array.from(ascii("<html><body>nothing here</body></html>")),
    "text/html",
  );

  expect(found).toEqual([
    {
      title: "Attempt to use OpenRSS",
      url: "https://openrss.org/site.example/",
      websub: false,
    },
  ]);
  expect(probed).toEqual([]);
});

const bigFeed = {
  description: null,
  items: Array.from({ length: previewArticleLimit + 5 }, (_, index) => ({
    authors: [{ name: "Author" }],
    content: `<p onclick="x()">Body ${index}</p><a href="post-${index}">more</a>`,
    description: null,
    id: `item-${index}`,
    published: new Date("2026-07-19T12:00:00.000Z"),
    title: `Article ${index}`,
    updated: null,
    url: `https://site.example/${index}`,
  })),
  title: "Big feed",
  url: page,
};

test("preview caches the parsed feed for subscribe and answers sanitized articles", async () => {
  const saved: string[] = [];
  const reply = await requestsFor({
    feedParser: strictFake<FeedParser>({
      preview: async (feedUrl) => mapFeedToPreview(bigFeed, feedUrl),
    }),
    feedPreviewCache: strictFake<FeedPreviewCache>({
      save: async (userId, feedUrl, preview) => {
        saved.push(`${userId} ${feedUrl} ${preview.feed ? "full" : "sample"}`);
      },
    }),
  }).preview(7, "https://site.example/feed");

  if (!("preview" in reply)) throw new Error("Expected a preview");
  expect(saved).toEqual(["7 https://site.example/feed full"]);
  expect(reply.preview.truncated).toBe(true);
  expect(reply.preview.articles).toHaveLength(previewArticleLimit);
  expect(reply.preview.articles[0]).toEqual({
    author: "Author",
    content: extractArticle(
      mapFeedToPreview(bigFeed, "https://site.example/feed").articles[0]
        ?.content,
    ),
    enclosures: [],
    publishedAt: "2026-07-19T12:00:00.000Z",
    title: "Article 0",
    url: "https://site.example/0",
  });
});

test("preview passes a parser failure back as a value", async () => {
  const reply = await requestsFor({
    feedParser: strictFake<FeedParser>({
      preview: async () => ({ failure: "HTTP 404 for https://site.example/" }),
    }),
  }).preview(7, page);

  expect(reply).toEqual({ failure: "HTTP 404 for https://site.example/" });
});

test("a snapshot import maps a truncated preview in full before recording it", async () => {
  const recorded: [number, string[]][] = [];
  const snapshot = serializeFeedPreview(
    mapFeedToPreview(bigFeed, "https://site.example/feed"),
  );
  const reply = await requestsFor({
    articleImporter: strictFake<ArticleImporter>({
      recordFetch: async (sourceId, articles) => {
        recorded.push([sourceId, articles.map((article) => article.guid)]);
      },
    }),
  }).importSnapshot(91, "https://site.example/feed", snapshot);

  expect(reply).toEqual({ imported: true });
  expect(recorded).toEqual([[91, bigFeed.items.map((item) => item.id)]]);
});

test("a snapshot for another URL, or truncated without its feed, is invalid", async () => {
  const requests = requestsFor({});
  const { feed: _feed, ...withoutFeed } = mapFeedToPreview(
    bigFeed,
    "https://site.example/feed",
  );

  expect(
    await requests.importSnapshot(
      91,
      "https://other.example/feed",
      serializeFeedPreview(withoutFeed),
    ),
  ).toEqual({ invalid: true });
  expect(
    await requests.importSnapshot(
      91,
      "https://site.example/feed",
      serializeFeedPreview(withoutFeed),
    ),
  ).toEqual({ invalid: true });
  expect(
    await requests.importSnapshot(91, "https://site.example/feed", "{"),
  ).toEqual({ invalid: true });
});

test("sanitize answers the content the importer would store", async () => {
  const content = '<img src="x" onerror="alert(1)">';

  expect(await requestsFor({}).sanitize(content)).toBe(extractArticle(content));
});
