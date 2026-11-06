import { Elysia } from "elysia";
import {
  articleQuery,
  articlesRequest,
  createFolderRequest,
  readArticlesRequest,
  removeArticlesRequest,
  removeFolderRequest,
  removeSourceRequest,
  snoozeSourceRequest,
  updateFolderRequest,
  updateSourceRequest,
} from "#shared/contracts/requests.ts";
import {
  articleResponse,
  folderResponse,
  foldersResponse,
  removedIdResponse,
  snoozedSourceResponse,
  updatedFolderResponse,
  updatedSourceResponse,
} from "#shared/contracts/responses.ts";
import { createAuthPlugin } from "#features/auth/session-plugin.ts";
import {
  deleteArticlesHandler,
  patchArticlesHandler,
  postArticlesHandler,
} from "#features/reader/routes/articles.ts";
import { getEventsHandler } from "#features/reader/routes/events.ts";
import { getTreeHandler } from "#features/reader/routes/tree.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { safeArticleUrl } from "#shared/util/safe-url.ts";
import { extractArticle } from "#features/feeds/extract-article.ts";
import type * as feeds from "#features/feeds/services.ts";

// Whatever the handlers below declare they need, so the group asks for no
// more than its routes use.
export type ReaderRouteServices = Parameters<typeof createAuthPlugin>[0] &
  Parameters<typeof getTreeHandler>[1] &
  Parameters<typeof getEventsHandler>[1] &
  Parameters<typeof postArticlesHandler>[1] &
  Parameters<typeof deleteArticlesHandler>[1] &
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
        json(foldersResponse, await foldersDataService.getUserFolders(user.id)),
      )
      .post(
        "/api/folders",
        { body: createFolderRequest },
        async ({ body, user }) =>
          json(
            folderResponse,
            await foldersDataService.createFolder(user.id, body.name),
          ),
      )
      .delete(
        "/api/folders",
        { body: removeFolderRequest },
        async ({ body, user }) => {
          const result = await foldersDataService.removeEmptyUserFolder(
            user.id,
            body.removeFolderId,
          );
          if (result === "not-found") return jsonError("Folder not found", 404);
          if (result === "not-empty")
            return jsonError("Folder is not empty", 409);
          return json(removedIdResponse, body.removeFolderId);
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
          if (!updated) return jsonError("Folder not found", 404);
          return json(updatedFolderResponse, { folderId: updated.id });
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
          return json(removedIdResponse, body.removeSourceId);
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
          if (!updated) return jsonError("Invalid folder or source", 400);
          return json(updatedSourceResponse, { sourceId: updated.id });
        },
      )
      // Article state and unread counts are left alone: suppression is
      // evaluated wherever unread is read (#725).
      .patch(
        "/api/source/snooze",
        { body: snoozeSourceRequest },
        async ({ body, user }) => {
          const updated = await userSourcesDataService.setSourceSnooze(
            user.id,
            body.sourceId,
            body.pausedUntil === null ? null : new Date(body.pausedUntil),
          );
          if (!updated) return jsonError("Invalid source", 400);
          return json(snoozedSourceResponse, {
            pausedUntil: updated.pausedUntil,
            sourceId: updated.id,
          });
        },
      )
      .get(
        "/api/article",
        { query: articleQuery },
        async ({ query, request, user }) => {
          const article = await articlesDataService.getUserArticle(
            query.article,
            user.id,
          );
          if (!article) return jsonError("Article not found", 404);
          return json(articleResponse, {
            ...article,
            content: extractArticle(article.content),
            url: safeArticleUrl(article.url, request.url),
          });
        },
      )
  );
};
