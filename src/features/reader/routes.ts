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
import { getArticleHandler } from "#features/reader/routes/article.ts";
import {
  deleteArticlesHandler,
  patchArticlesHandler,
  postArticlesHandler,
} from "#features/reader/routes/articles.ts";
import {
  deleteFoldersHandler,
  getFoldersHandler,
  patchFoldersHandler,
  postFoldersHandler,
} from "#features/reader/routes/folders.ts";
import {
  deleteSourceHandler,
  patchSourceHandler,
  snoozeSourceHandler,
} from "#features/reader/routes/source.ts";
import { getEventsHandler } from "#features/reader/routes/events.ts";
import { getTreeHandler } from "#features/reader/routes/tree.ts";
// Whatever the handlers below declare they need, so the group asks for no
// more than its routes use.
export type ReaderRouteServices = Parameters<typeof createAuthPlugin>[0] &
  Parameters<typeof getTreeHandler>[1] &
  Parameters<typeof getEventsHandler>[1] &
  Parameters<typeof getFaviconHandler>[1] &
  Parameters<typeof postArticlesHandler>[1] &
  Parameters<typeof deleteArticlesHandler>[1] &
  Parameters<typeof getFoldersHandler>[1] &
  Parameters<typeof deleteSourceHandler>[1] &
  Parameters<typeof getPreviewHandler>[1] &
  Parameters<typeof getFindHandler>[1] &
  Parameters<typeof getArticleHandler>[1] &
  Parameters<typeof postSubscribeHandler>[1];

export const createReaderRoutes = (services: ReaderRouteServices) =>
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
    .get("/api/folders", (ctx) => getFoldersHandler(ctx, services))
    .post("/api/folders", { body: createFolderRequest }, (ctx) =>
      postFoldersHandler(ctx, services),
    )
    .delete("/api/folders", { body: removeFolderRequest }, (ctx) =>
      deleteFoldersHandler(ctx, services),
    )
    .patch("/api/folders", { body: updateFolderRequest }, (ctx) =>
      patchFoldersHandler(ctx, services),
    )
    .delete("/api/source", { body: removeSourceRequest }, (ctx) =>
      deleteSourceHandler(ctx, services),
    )
    .patch("/api/source", { body: updateSourceRequest }, (ctx) =>
      patchSourceHandler(ctx, services),
    )
    .patch("/api/source/snooze", { body: snoozeSourceRequest }, (ctx) =>
      snoozeSourceHandler(ctx, services),
    )
    .get("/api/preview", { query: previewQuery }, (ctx) =>
      getPreviewHandler(ctx, services),
    )
    .get("/api/find", { query: findQuery }, (ctx) =>
      getFindHandler(ctx, services),
    )
    .get("/api/article", { query: articleQuery }, (ctx) =>
      getArticleHandler(ctx, services),
    )
    .post("/api/subscribe", { body: subscribeRequest }, (ctx) =>
      postSubscribeHandler(ctx, services),
    );
