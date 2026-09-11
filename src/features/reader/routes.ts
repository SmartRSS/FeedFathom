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
import { getTreeHandler } from "#features/reader/routes/tree.ts";

export const createReaderRoutes = () =>
  new Elysia()
    .use(createAuthPlugin())
    .get("/api/tree", (ctx) => getTreeHandler(ctx))
    .get("/api/favicon/:id", (ctx) => getFaviconHandler(ctx))
    .post("/api/articles", { body: articlesRequest }, (ctx) =>
      postArticlesHandler(ctx),
    )
    .delete("/api/articles", { body: removeArticlesRequest }, (ctx) =>
      deleteArticlesHandler(ctx),
    )
    .patch("/api/articles", { body: readArticlesRequest }, (ctx) =>
      patchArticlesHandler(ctx),
    )
    .get("/api/folders", (ctx) => getFoldersHandler(ctx))
    .post("/api/folders", { body: createFolderRequest }, (ctx) =>
      postFoldersHandler(ctx),
    )
    .delete("/api/folders", { body: removeFolderRequest }, (ctx) =>
      deleteFoldersHandler(ctx),
    )
    .patch("/api/folders", { body: updateFolderRequest }, (ctx) =>
      patchFoldersHandler(ctx),
    )
    .delete("/api/source", { body: removeSourceRequest }, (ctx) =>
      deleteSourceHandler(ctx),
    )
    .patch("/api/source", { body: updateSourceRequest }, (ctx) =>
      patchSourceHandler(ctx),
    )
    .patch("/api/source/snooze", { body: snoozeSourceRequest }, (ctx) =>
      snoozeSourceHandler(ctx),
    )
    .get("/api/preview", { query: previewQuery }, (ctx) =>
      getPreviewHandler(ctx),
    )
    .get("/api/find", { query: findQuery }, (ctx) => getFindHandler(ctx))
    .get("/api/article", { query: articleQuery }, (ctx) =>
      getArticleHandler(ctx),
    )
    .post("/api/subscribe", { body: subscribeRequest }, (ctx) =>
      postSubscribeHandler(ctx),
    );
