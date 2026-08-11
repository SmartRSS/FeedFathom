// TEMPORARY: WebSub push verification, remove after confirming. Self-hosted
// so tests don't depend on a third-party CDN's cache propagating (GitHub
// gist raw URLs have an unpredictable, edge-dependent delay that made
// earlier tests flaky) and so nothing in front of this API path caches it.
import { Elysia } from "elysia";
import { Type } from "typebox";
import Schema from "typebox/schema";

type DebugFeedRedis = {
  get(key: string): Promise<null | string>;
  set(key: string, value: string): Promise<unknown>;
};

const redisKey = "debug:websub-test-feed:items";
const domain = "https://cleverss.zakius.xyz";
const feedUrl = `${domain}/api/debug/websub-feed`;

const itemsSchema = Type.Array(
  Type.Object({
    guid: Type.String(),
    pubDate: Type.String(),
    title: Type.String(),
  }),
);
const itemsCheck = Schema.Compile(itemsSchema);

async function loadItems(redis: DebugFeedRedis) {
  const raw = await redis.get(redisKey);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return itemsCheck.Check(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function renderFeed(items: { guid: string; pubDate: string; title: string }[]) {
  const itemsXml = items
    .map(
      (item) => `    <item>
      <title>${item.title}</title>
      <link>${feedUrl}#${item.guid}</link>
      <guid>${item.guid}</guid>
      <pubDate>${item.pubDate}</pubDate>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <atom:link rel="hub" href="https://pubsubhubbub.appspot.com/"/>
    <atom:link rel="self" href="${feedUrl}"/>
    <title>FeedFathom WebSub debug feed</title>
    <link>${domain}</link>
    <description>Temporary self-hosted feed for verifying WebSub push delivery.</description>
${itemsXml}
  </channel>
</rss>`;
}

export function createDebugWebSubFeedRoutes(dependencies: {
  redis: DebugFeedRedis;
}) {
  return new Elysia()
    .get("/api/debug/websub-feed", async () => {
      const items = await loadItems(dependencies.redis);
      return new Response(renderFeed(items), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/rss+xml",
        },
      });
    })
    .post("/api/debug/websub-feed", async ({ body }) => {
      const items = await loadItems(dependencies.redis);
      const title =
        typeof body === "object" && body !== null && "title" in body
          ? String((body as Record<string, unknown>)["title"])
          : `Debug push item ${items.length + 1}`;
      items.push({
        guid: `debug-push-${Date.now()}`,
        pubDate: new Date().toUTCString(),
        title,
      });
      await dependencies.redis.set(redisKey, JSON.stringify(items));
      return new Response(renderFeed(items), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/rss+xml",
        },
      });
    });
}
