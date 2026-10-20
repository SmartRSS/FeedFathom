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
  if (
    !body.sources.length &&
    body.view !== "today" &&
    !body.query &&
    body.folder === undefined
  )
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
        : body.folder === undefined
          ? {}
          : { folderId: body.folder },
  );
  return json(
    articles.map(({ revision, ...article }) =>
      Object.assign(article, body.revision ? { revision } : {}, {
        url: safeArticleUrl(article.url, request.url),
      }),
    ),
  );
}

// Client-supplied, so capped; JSON.stringify escapes it onto one log line.
const MAX_TRACE_LOG_LENGTH = 4000;

export async function deleteArticlesHandler({
  body,
  request,
  user,
}: {
  body: Static<typeof removeArticlesRequest>;
  request: Request;
  user: AuthedUser;
}) {
  const { articleIds, sourceIds } =
    await articlesDataService.removeUserArticles(
      body.removedArticleIdList,
      user.id,
    );
  // Deletes are terminal and were once sent by nobody anyone could name
  // (see src/spa/delete-trace.ts), so each one is logged with what the
  // client says triggered it.
  console.info(
    JSON.stringify({
      cfRay: request.headers.get("cf-ray"),
      event: "articles.delete",
      removed: articleIds,
      replayQueuedAt: request.headers.get("x-feedfathom-replay"),
      requested: body.removedArticleIdList,
      trace:
        request.headers
          .get("x-feedfathom-trace")
          ?.slice(0, MAX_TRACE_LOG_LENGTH) ?? null,
      userAgent: request.headers.get("user-agent"),
      userId: user.id,
    }),
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
