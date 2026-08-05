import type { Static } from "typebox";
import { Value } from "typebox/value";
import { articleQuery } from "../../contracts/requests.ts";
import type { ArticlesDataService } from "../../db/data-services/article-data-service.ts";
import { extractArticle } from "../../lib/extract-article.ts";
import { safeArticleUrl } from "../../lib/feed-mapper.ts";
import { type AuthedUser, json } from "../shared.ts";

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
