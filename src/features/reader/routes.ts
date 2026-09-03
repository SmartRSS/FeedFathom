import { Elysia } from "elysia";
import {
  articleQuery,
  articlesRequest,
  createFolderRequest,
  findQuery,
  previewQuery,
  removeArticlesRequest,
  removeFolderRequest,
  removeSourceRequest,
  subscribeRequest,
  updateFolderRequest,
  updateSourceRequest,
} from "#shared/contracts/requests.ts";
import { createAuthPlugin } from "#features/auth/session-plugin.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";
import { getFaviconHandler } from "#features/feeds/routes/favicon.ts";
import { getFindHandler } from "#features/feeds/routes/find.ts";
import { getPreviewHandler } from "#features/feeds/routes/preview.ts";
import { postSubscribeHandler } from "#features/feeds/routes/subscribe.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import type { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { getArticleHandler } from "#features/reader/routes/article.ts";
import {
  deleteArticlesHandler,
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
} from "#features/reader/routes/source.ts";
import { getTreeHandler } from "#features/reader/routes/tree.ts";

export type ReaderRouteDependencies = {
  articlesDataService: Pick<
    ArticlesDataService,
    | "batchUpsertArticles"
    | "getUserArticle"
    | "getUserArticlesForSources"
    | "removeUserArticles"
  >;
  usersDataService: Pick<UsersDataService, "getUserBySid" | "touchLastSeen">;
  feedParser: Pick<
    FeedParser,
    "discoverAndSubscribeWebSub" | "parseUrl" | "preview"
  >;
  feedPreviewCache: Pick<FeedPreviewCache, "get" | "save">;
  foldersDataService: Pick<
    FoldersDataService,
    "createFolder" | "getUserFolders" | "removeEmptyUserFolder" | "renameFolder"
  >;
  httpClient: {
    get(url: string): Promise<{ data: string }>;
  };
  mailEnabled: boolean;
  sourcesDataService: Pick<
    SourcesDataService,
    "enqueueSource" | "getFavicon" | "successSource"
  >;
  userSourcesDataService: Pick<
    UserSourcesDataService,
    | "addSourceToUser"
    | "recomputeUnreadCounts"
    | "getUserSources"
    | "removeSourceFromUser"
    | "updateUserSource"
    | "withSubscriptionInitializationLease"
  >;
};

export const createReaderRoutes = (deps: ReaderRouteDependencies) =>
  new Elysia()
    .use(createAuthPlugin(deps.usersDataService))
    .get("/api/tree", (ctx) => getTreeHandler(ctx, deps))
    .get("/api/favicon/:id", (ctx) => getFaviconHandler(ctx, deps))
    .post("/api/articles", { body: articlesRequest }, (ctx) =>
      postArticlesHandler(ctx, deps),
    )
    .delete("/api/articles", { body: removeArticlesRequest }, (ctx) =>
      deleteArticlesHandler(ctx, deps),
    )
    .get("/api/folders", (ctx) => getFoldersHandler(ctx, deps))
    .post("/api/folders", { body: createFolderRequest }, (ctx) =>
      postFoldersHandler(ctx, deps),
    )
    .delete("/api/folders", { body: removeFolderRequest }, (ctx) =>
      deleteFoldersHandler(ctx, deps),
    )
    .patch("/api/folders", { body: updateFolderRequest }, (ctx) =>
      patchFoldersHandler(ctx, deps),
    )
    .delete("/api/source", { body: removeSourceRequest }, (ctx) =>
      deleteSourceHandler(ctx, deps),
    )
    .patch("/api/source", { body: updateSourceRequest }, (ctx) =>
      patchSourceHandler(ctx, deps),
    )
    .get("/api/preview", { query: previewQuery }, (ctx) =>
      getPreviewHandler(ctx, deps),
    )
    .get("/api/find", { query: findQuery }, (ctx) => getFindHandler(ctx, deps))
    .get("/api/article", { query: articleQuery }, (ctx) =>
      getArticleHandler(ctx, deps),
    )
    .post("/api/subscribe", { body: subscribeRequest }, (ctx) =>
      postSubscribeHandler(ctx, deps),
    );
