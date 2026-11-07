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

// A source created without a known homepage links to its feed's origin; the
// first fetch corrects that to the site the feed names, which is where the
// favicon refresh looks.
test("a poll records the articles and the site the feed names", async () => {
  const recorded: Parameters<ArticleImporter["recordFetch"]>[] = [];
  const parser = new FeedParser(
    strictFake<ArticleImporter>({
      async recordFetch(...args) {
        recorded.push(args);
      },
    }),
    servingFeed(
      "<rss><channel><link>/blog/</link><item><guid>a</guid></item></channel></rss>",
    ),
    strictFake<SourcesDataService>({}),
    strictFake<WebSubSubscriber>({ wants: () => false }),
    sameUrl,
  );

  await parser.parseSource({ id: 7, url: "https://cdn.example/feed.xml" });

  expect(recorded).toHaveLength(1);
  const [sourceId, articles, fetch] = recorded[0]!;
  expect(sourceId).toBe(7);
  expect(articles.map(({ guid }) => guid)).toEqual(["a"]);
  expect(fetch).toMatchObject({
    homeUrl: "https://cdn.example/blog/",
    trigger: "poll",
  });
});

// The temporary-redirect cache only saves a hop next time; a Redis write
// failing must not turn a fetched feed into a failed one.
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
  using logged = spyOn(console, "error").mockImplementation(() => {});

  const preview = await parser.preview("https://publisher.example/feed.xml");

  expect(
    "articles" in preview ? preview.articles.map(({ guid }) => guid) : [],
  ).toEqual(["a"]);
  expect(logged).toHaveBeenCalledTimes(1);
});
