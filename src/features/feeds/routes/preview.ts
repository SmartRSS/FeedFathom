import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { previewQuery } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { errorResponse, previewResponse } from "#shared/contracts/responses.ts";
import { extractArticle } from "#features/feeds/extract-article.ts";
import { describeFetchFailure } from "#shared/util/fetch-failure.ts";

export async function getPreviewHandler(
  {
    query: decoded,
    user,
  }: {
    query: StaticDecode<typeof previewQuery>;
    user: AuthedUser;
  },
  {
    feedParser,
    feedPreviewCache,
    outboundFetchBudget,
  }: Pick<
    typeof feeds,
    "feedParser" | "feedPreviewCache" | "outboundFetchBudget"
  >,
) {
  // Counted before any outbound work, including a cache hit: the budget is
  // about how often a user can ask us to reach out at all.
  await outboundFetchBudget.consume(user.id);
  const source = await feedParser.preview(decoded.feedUrl);
  // The sentence is what a reader sees; the fetcher's own words are for an
  // admin's Details.
  if ("failure" in source)
    return json(
      errorResponse,
      { detail: source.failure, error: describeFetchFailure(source.failure) },
      400,
    );
  await feedPreviewCache.save(user.id, decoded.feedUrl, source);
  return json(previewResponse, {
    articles: source.articles.map((article) => ({
      author: article.author,
      content: extractArticle(article.content),
      enclosures: article.enclosures,
      publishedAt: article.publishedAt,
      title: article.title,
      url: article.url,
    })),
    description: source.description,
    feedUrl: source.feedUrl,
    link: source.link,
    title: source.title,
    truncated: source.truncated ?? false,
  });
}
