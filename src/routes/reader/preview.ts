import type { Static } from "typebox";
import { Value } from "typebox/value";
import { previewQuery } from "#shared/contracts/requests.ts";
import type { FeedParser } from "../../lib/feed-parser.ts";
import { extractArticle } from "../../lib/extract-article.ts";
import { HttpDeferredError } from "../../lib/http-client.ts";
import type { FeedPreviewCache } from "../../lib/feed-preview-cache.ts";
import { type AuthedUser, json } from "../shared.ts";
import { deferredResponse } from "./deferred-response.ts";

export type PreviewRouteDependencies = {
  feedParser: Pick<FeedParser, "preview">;
  feedPreviewCache: Pick<FeedPreviewCache, "save">;
};

export async function getPreviewHandler(
  { query, user }: { query: Static<typeof previewQuery>; user: AuthedUser },
  { feedParser, feedPreviewCache }: PreviewRouteDependencies,
) {
  const decoded = Value.Decode(previewQuery, query);
  let source;
  try {
    source = await feedParser.preview(decoded.feedUrl);
  } catch (error_: unknown) {
    if (error_ instanceof HttpDeferredError) return deferredResponse(error_);
    throw error_;
  }
  if (!source) return json({ error: "Invalid feed url" }, 400);
  await feedPreviewCache.save(user.id, decoded.feedUrl, source);
  return json({
    articles: await Promise.all(
      source.articles.map(async (article) => ({
        author: article.author,
        content: extractArticle(article.content),
        publishedAt: article.publishedAt,
        title: article.title,
        url: article.url,
      })),
    ),
    description: source.description,
    feedUrl: source.feedUrl,
    link: source.link,
    title: source.title,
  });
}
