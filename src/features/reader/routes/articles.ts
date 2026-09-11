import {
  articlesDataService,
  userSourcesDataService,
} from "#features/feeds/services.ts";
import type { Static } from "typebox";
import type {
  articlesRequest,
  readArticlesRequest,
  removeArticlesRequest,
} from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { safeArticleUrl } from "#shared/util/safe-url.ts";

export async function postArticlesHandler({
  body,
  request,
  user,
}: {
  body: Static<typeof articlesRequest>;
  request: Request;
  user: AuthedUser;
}) {
  if (!body.sources.length && body.view !== "today" && !body.query)
    return json([]);
  const articles = await articlesDataService.getUserArticlesForSources(
    body.sources,
    user.id,
    body.cursor,
    body.filter,
    body.view === "today"
      ? { allSubscribed: true, publishedWithinHours: 24 }
      : // Search (#697) spans every subscription -- what makes it worth
        // having is finding the article whose feed you no longer remember --
        // so subscription authorizes the rows, as it does for Today.
        body.query
        ? { allSubscribed: true, query: body.query }
        : {},
  );
  return json(
    articles.map((article) =>
      Object.assign(article, {
        url: safeArticleUrl(article.url, request.url),
      }),
    ),
  );
}

export async function deleteArticlesHandler({
  body,
  user,
}: {
  body: Static<typeof removeArticlesRequest>;
  user: AuthedUser;
}) {
  const { articleIds, sourceIds } =
    await articlesDataService.removeUserArticles(
      body.removedArticleIdList,
      user.id,
    );
  await userSourcesDataService.recomputeUnreadCounts(sourceIds, user.id);
  return json(articleIds);
}

export async function patchArticlesHandler({
  body,
  user,
}: {
  body: Static<typeof readArticlesRequest>;
  user: AuthedUser;
}) {
  const { articleIds, sourceIds } =
    await articlesDataService.setUserArticlesRead(
      body.articleIdList,
      user.id,
      body.read,
    );
  // Same as the delete path: the badge beside every affected source is
  // recomputed from the store rather than adjusted by a count kept here.
  await userSourcesDataService.recomputeUnreadCounts(sourceIds, user.id);
  return json(articleIds);
}
