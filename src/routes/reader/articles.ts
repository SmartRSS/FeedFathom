import type { Static } from "typebox";
import type {
  articlesRequest,
  removeArticlesRequest,
} from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import type { ArticlesDataService } from "../../db/data-services/article-data-service.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import { safeArticleUrl } from "../../lib/feed-mapper.ts";

export type ArticlesRouteDependencies = {
  articlesDataService: Pick<
    ArticlesDataService,
    "getUserArticlesForSources" | "removeUserArticles"
  >;
  userSourcesDataService: Pick<UserSourcesDataService, "recomputeUnreadCounts">;
};

export async function postArticlesHandler(
  {
    body,
    request,
    user,
  }: {
    body: Static<typeof articlesRequest>;
    request: Request;
    user: AuthedUser;
  },
  { articlesDataService }: ArticlesRouteDependencies,
) {
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
}

export async function deleteArticlesHandler(
  {
    body,
    user,
  }: { body: Static<typeof removeArticlesRequest>; user: AuthedUser },
  { articlesDataService, userSourcesDataService }: ArticlesRouteDependencies,
) {
  const { articleIds, sourceIds } =
    await articlesDataService.removeUserArticles(
      body.removedArticleIdList,
      user.id,
    );
  await userSourcesDataService.recomputeUnreadCounts(sourceIds, user.id);
  return json(articleIds);
}
