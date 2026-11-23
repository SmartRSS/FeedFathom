import { Readable } from "node:stream";
import { expect, spyOn, test } from "bun:test";
import { FeedParser } from "#features/feeds/feed-parser.ts";
import type { ArticleImporter } from "#features/feeds/article-import.ts";
import type { RedirectMap } from "#features/feeds/redirect-map.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { WebSubSubscriber } from "#features/feeds/websub-subscriber.ts";
import { HttpClient } from "#platform/http/http-client.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";

const servingFeed = (text: string, url = "https://cdn.example/feed.xml") =>
  new HttpClient(createFakeHttpRedis(), {
    transport: async () => ({
      body: Readable.from([new TextEncoder().encode(text)]),
      destroy() {},
      headers: new Headers({ "content-type": "application/rss+xml" }),
      status: 200,
      url,
    }),
  });

const sameUrl = strictFake<RedirectMap>({ resolveUrl: async (url) => url });

test("a failed redirect-cache write still returns the redirected feed", async () => {
  const parser = new FeedParser(
    strictFake<ArticleImporter>({}),
    servingFeed(
      "<rss><channel><title>Moved</title><item><guid>a</guid><link>https://cdn.example/a</link></item></channel></rss>",
    ),
    strictFake<SourcesDataService>({}),
    strictFake<WebSubSubscriber>({}),
    strictFake<RedirectMap>({
      resolveUrl: async (url) => url,
      setRedirect: async () => {
        throw new Error("redis is down");
      },
    }),
  );
  using _ = spyOn(console, "error").mockImplementation(() => {});

  const preview = await parser.preview("https://publisher.example/feed.xml");

  expect(
    "articles" in preview ? preview.articles.map(({ guid }) => guid) : [],
  ).toEqual(["a"]);
});

test("metadataOnly discovers WebSub hubs without parsing feed items", async () => {
  const parser = new FeedParser(
    strictFake<ArticleImporter>({}),
    servingFeed(
      '<rss><channel><atom:link rel="hub" href="https://hub.example/"/><atom:link rel="self" href="https://cdn.example/feed.xml"/><broken',
    ),
    strictFake<SourcesDataService>({}),
    strictFake<WebSubSubscriber>({ wants: () => false }),
    sameUrl,
  );

  const result = await parser.parseUrl("https://cdn.example/feed.xml", {
    metadataOnly: true,
  });

  expect(result.websub).toEqual({
    hubUrl: "https://hub.example/",
    topicUrl: "https://cdn.example/feed.xml",
  });
  expect(result.feed.items).toEqual([]);
});
