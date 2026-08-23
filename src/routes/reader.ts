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
  updateSourceRequest,
} from "#shared/contracts/requests.ts";
import { createAuthPlugin } from "#features/auth/session-plugin.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";
import type { ArticlesDataService } from "../db/data-services/article-data-service.ts";
import type { FoldersDataService } from "../db/data-services/folder-data-service.ts";
import type { UserSourcesDataService } from "../db/data-services/user-source-data-service.ts";
import { getArticleHandler } from "./reader/article.ts";
import {
  deleteArticlesHandler,
  postArticlesHandler,
} from "./reader/articles.ts";
import { getFaviconHandler } from "./reader/favicon.ts";
import { getFindHandler } from "./reader/find.ts";
import {
  deleteFoldersHandler,
  getFoldersHandler,
  postFoldersHandler,
} from "./reader/folders.ts";
import { getPreviewHandler } from "./reader/preview.ts";
import { deleteSourceHandler, patchSourceHandler } from "./reader/source.ts";
import { postSubscribeHandler } from "./reader/subscribe.ts";
import { getTreeHandler } from "./reader/tree.ts";

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
    "createFolder" | "getUserFolders" | "removeEmptyUserFolder"
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
