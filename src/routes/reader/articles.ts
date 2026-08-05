import type { Static } from "typebox";
import {
  articlesRequest,
  removeArticlesRequest,
} from "../../contracts/requests.ts";
import type { ArticlesDataService } from "../../db/data-services/article-data-service.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import { safeArticleUrl } from "../../lib/feed-mapper.ts";
import { type AuthedUser, json } from "../shared.ts";

export type ArticlesRouteDependencies = {
  articlesDataService: Pick<
    ArticlesDataService,
    "getUserArticlesForSources" | "removeUserArticles"
  >;
  userSourcesDataService: Pick<
    UserSourcesDataService,
    "recomputeUnreadCountsForUser"
  >;
};

export async function postArticlesHandler(
  {
    body,
    request,
    user,
  }: { body: Static<typeof articlesRequest>; request: Request; user: AuthedUser },
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
  const { articleIds, sourceIds } = await articlesDataService.removeUserArticles(
    body.removedArticleIdList,
    user.id,
  );
  await userSourcesDataService.recomputeUnreadCountsForUser(
    user.id,
    sourceIds,
  );
  return json(articleIds);
}
