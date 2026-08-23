import type { Static } from "typebox";
import { Value } from "typebox/value";
import { articleQuery } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { safeArticleUrl } from "#features/feeds/feed-mapper.ts";
import type { ArticlesDataService } from "#features/reader/article-data-service.ts";
import { extractArticle } from "#features/reader/extract-article.ts";

export type ArticleRouteDependencies = {
  articlesDataService: Pick<ArticlesDataService, "getUserArticle">;
};

export async function getArticleHandler(
  {
    query,
    request,
    user,
  }: {
    query: Static<typeof articleQuery>;
    request: Request;
    user: AuthedUser;
  },
  { articlesDataService }: ArticleRouteDependencies,
) {
  const decoded = Value.Decode(articleQuery, query);
  const article = await articlesDataService.getUserArticle(
    decoded.article,
    user.id,
  );
  if (!article) return json({}, 404);
  return json({
    ...article,
    content: extractArticle(article.content),
    url: safeArticleUrl(article.url, request.url),
  });
}
