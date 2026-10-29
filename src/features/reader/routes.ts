import { Elysia } from "elysia";
import {
  articleQuery,
  articlesRequest,
  createFolderRequest,
  findQuery,
  previewQuery,
  readArticlesRequest,
  removeArticlesRequest,
  removeFolderRequest,
  removeSourceRequest,
  snoozeSourceRequest,
  subscribeRequest,
  updateFolderRequest,
  updateSourceRequest,
} from "#shared/contracts/requests.ts";
import { createAuthPlugin } from "#features/auth/session-plugin.ts";
import { getFaviconHandler } from "#features/feeds/routes/favicon.ts";
import { getFindHandler } from "#features/feeds/routes/find.ts";
import { getPreviewHandler } from "#features/feeds/routes/preview.ts";
import { postSubscribeHandler } from "#features/feeds/routes/subscribe.ts";
import {
  deleteArticlesHandler,
  patchArticlesHandler,
  postArticlesHandler,
} from "#features/reader/routes/articles.ts";
import { getEventsHandler } from "#features/reader/routes/events.ts";
import { getTreeHandler } from "#features/reader/routes/tree.ts";
import { json } from "#platform/http/json.ts";
import { safeArticleUrl } from "#shared/util/safe-url.ts";
import { extractArticle } from "#features/feeds/extract-article.ts";
import type * as feeds from "#features/feeds/services.ts";
// Whatever the handlers below declare they need, so the group asks for no
// more than its routes use.
export type ReaderRouteServices = Parameters<typeof createAuthPlugin>[0] &
  Parameters<typeof getTreeHandler>[1] &
  Parameters<typeof getEventsHandler>[1] &
  Parameters<typeof getFaviconHandler>[1] &
  Parameters<typeof postArticlesHandler>[1] &
  Parameters<typeof deleteArticlesHandler>[1] &
  Parameters<typeof getPreviewHandler>[1] &
  Parameters<typeof getFindHandler>[1] &
  Parameters<typeof postSubscribeHandler>[1] &
  Pick<
    typeof feeds,
    "articlesDataService" | "foldersDataService" | "userSourcesDataService"
  >;

export const createReaderRoutes = (services: ReaderRouteServices) => {
  const { articlesDataService, foldersDataService, userSourcesDataService } =
    services;
  return (
    new Elysia()
      .use(createAuthPlugin(services))
      .get("/api/tree", (ctx) => getTreeHandler(ctx, services))
      .get("/api/events", (ctx) => getEventsHandler(ctx, services))
      .get("/api/favicon/:id", (ctx) => getFaviconHandler(ctx, services))
      .post("/api/articles", { body: articlesRequest }, (ctx) =>
        postArticlesHandler(ctx, services),
      )
      .delete("/api/articles", { body: removeArticlesRequest }, (ctx) =>
        deleteArticlesHandler(ctx, services),
      )
      .patch("/api/articles", { body: readArticlesRequest }, (ctx) =>
        patchArticlesHandler(ctx, services),
      )
      .get("/api/folders", async ({ user }) =>
        json(await foldersDataService.getUserFolders(user.id)),
      )
      .post(
        "/api/folders",
        { body: createFolderRequest },
        async ({ body, user }) =>
          json(await foldersDataService.createFolder(user.id, body.name)),
      )
      .delete(
        "/api/folders",
        { body: removeFolderRequest },
        async ({ body, user }) => {
          const result = await foldersDataService.removeEmptyUserFolder(
            user.id,
            body.removeFolderId,
          );
          if (result === "not-found")
            return json({ error: "Folder not found" }, 404);
          if (result === "not-empty")
            return json({ error: "Folder is not empty" }, 409);
          return json(body.removeFolderId);
        },
      )
      .patch(
        "/api/folders",
        { body: updateFolderRequest },
        async ({ body, user }) => {
          const updated = await foldersDataService.renameFolder(
            user.id,
            body.folderId,
            body.folderName,
          );
          if (!updated) return json({ error: "Folder not found" }, 404);
          return json({ folderId: updated.id });
        },
      )
      .delete(
        "/api/source",
        { body: removeSourceRequest },
        async ({ body, user }) => {
          await userSourcesDataService.removeSourceFromUser(
            user.id,
            body.removeSourceId,
          );
          return json(body.removeSourceId);
        },
      )
      .patch(
        "/api/source",
        { body: updateSourceRequest },
        async ({ body, user }) => {
          const updated = await userSourcesDataService.updateUserSource(
            user.id,
            body.sourceId,
            { name: body.sourceName, parentId: body.sourceFolder },
          );
          if (!updated) return json({ error: "Invalid folder or source" }, 400);
          return json({ sourceId: updated.id });
        },
      )
      // Sets (or clears, with null) one subscription's snooze (#725). The write
      // touches only the timestamp -- article state and unread counts are left
      // alone, and suppression is evaluated lazily wherever unread is read.
      .patch(
        "/api/source/snooze",
        { body: snoozeSourceRequest },
        async ({ body, user }) => {
          const updated = await userSourcesDataService.setSourceSnooze(
            user.id,
            body.sourceId,
            body.pausedUntil === null ? null : new Date(body.pausedUntil),
          );
          if (!updated) return json({ error: "Invalid source" }, 400);
          return json({
            pausedUntil: updated.pausedUntil?.toJSON() ?? null,
            sourceId: updated.id,
          });
        },
      )
      .get("/api/preview", { query: previewQuery }, (ctx) =>
        getPreviewHandler(ctx, services),
      )
      .get("/api/find", { query: findQuery }, (ctx) =>
        getFindHandler(ctx, services),
      )
      .get(
        "/api/article",
        { query: articleQuery },
        async ({ query, request, user }) => {
          const article = await articlesDataService.getUserArticle(
            query.article,
            user.id,
          );
          if (!article) return json({}, 404);
          return json({
            ...article,
            content: extractArticle(article.content),
            url: safeArticleUrl(article.url, request.url),
          });
        },
      )
      .post("/api/subscribe", { body: subscribeRequest }, (ctx) =>
        postSubscribeHandler(ctx, services),
      )
  );
};
