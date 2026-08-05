import { Elysia } from "elysia";
import type { ArticlesDataService } from "../db/data-services/article-data-service.ts";
import type { FoldersDataService } from "../db/data-services/folder-data-service.ts";
import type { SourcesDataService } from "../db/data-services/source-data-service.ts";
import type { UserSourcesDataService } from "../db/data-services/user-source-data-service.ts";
import type { UsersDataService } from "../db/data-services/user-data-service.ts";
import type { FeedParser } from "../lib/feed-parser.ts";
import type { FeedPreviewCache } from "../lib/feed-preview-cache.ts";
import { createArticleRoute } from "./reader/article.ts";
import { createArticlesRoutes } from "./reader/articles.ts";
import { createFaviconRoute } from "./reader/favicon.ts";
import { createFindRoute } from "./reader/find.ts";
import { createFoldersRoutes } from "./reader/folders.ts";
import { createPreviewRoute } from "./reader/preview.ts";
import { createSourceRoute } from "./reader/source.ts";
import { createSubscribeRoute } from "./reader/subscribe.ts";
import { createTreeRoute } from "./reader/tree.ts";

export type ReaderRouteDependencies = {
  articlesDataService: Pick<
    ArticlesDataService,
    | "batchUpsertArticles"
    | "getUserArticle"
    | "getUserArticlesForSources"
    | "removeUserArticles"
  >;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
  feedParser: Pick<FeedParser, "preview">;
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
    | "recomputeUnreadCountsForUser"
    | "removeSourceFromUser"
  > &
    Partial<
      Pick<
        UserSourcesDataService,
        | "claimSubscriptionInitialization"
        | "completeSubscriptionInitialization"
        | "releaseSubscriptionInitialization"
      >
    >;
};

export const createReaderRoutes = (deps: ReaderRouteDependencies) =>
  new Elysia()
    .use(createTreeRoute(deps))
    .use(createFaviconRoute(deps))
    .use(createArticlesRoutes(deps))
    .use(createFoldersRoutes(deps))
    .use(createSourceRoute(deps))
    .use(createPreviewRoute(deps))
    .use(createFindRoute(deps))
    .use(createArticleRoute(deps))
    .use(createSubscribeRoute(deps));
