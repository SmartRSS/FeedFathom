import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { articleQuery } from "../../contracts/requests.ts";
import type { ArticlesDataService } from "../../db/data-services/article-data-service.ts";
import { extractArticle } from "../../lib/extract-article.ts";
import { safeArticleUrl } from "../../lib/feed-mapper.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { createAuthPlugin, json } from "../shared.ts";

export type ArticleRouteDependencies = {
  articlesDataService: Pick<ArticlesDataService, "getUserArticle">;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createArticleRoute({
  articlesDataService,
  usersDataService,
}: ArticleRouteDependencies) {
  return new Elysia().use(createAuthPlugin(usersDataService)).get(
    "/api/article",
    { query: articleQuery },
    async ({ query, request, user }) => {
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
    },
  );
}
