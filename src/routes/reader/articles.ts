import { Elysia } from "elysia";
import {
  articlesRequest,
  removeArticlesRequest,
} from "../../contracts/requests.ts";
import type { ArticlesDataService } from "../../db/data-services/article-data-service.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { safeArticleUrl } from "../../lib/feed-mapper.ts";
import { createAuthPlugin, json } from "../shared.ts";

export type ArticlesRouteDependencies = {
  articlesDataService: Pick<
    ArticlesDataService,
    "getUserArticlesForSources" | "removeUserArticles"
  >;
  userSourcesDataService: Pick<
    UserSourcesDataService,
    "recomputeUnreadCountsForUser"
  >;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createArticlesRoutes({
  articlesDataService,
  userSourcesDataService,
  usersDataService,
}: ArticlesRouteDependencies) {
  return new Elysia()
    .use(createAuthPlugin(usersDataService))
    .post(
      "/api/articles",
      { body: articlesRequest },
      async ({ body, request, user }) => {
        if (!body.sources.length) return json([]);
        const articles = await articlesDataService.getUserArticlesForSources(
          body.sources,
          user.id,
        );
        return json(
          articles.map((article) =>
            Object.assign(article, {
              url: safeArticleUrl(article.url, request.url),
            }),
          ),
        );
      },
    )
    .delete(
      "/api/articles",
      { body: removeArticlesRequest },
      async ({ body, user }) => {
        const { articleIds, sourceIds } =
          await articlesDataService.removeUserArticles(
            body.removedArticleIdList,
            user.id,
          );
        await userSourcesDataService.recomputeUnreadCountsForUser(
          user.id,
          sourceIds,
        );
        return json(articleIds);
      },
    );
}
