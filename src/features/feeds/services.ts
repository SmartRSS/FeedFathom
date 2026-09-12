import { config } from "#platform/config.ts";
import {
  drizzleConnection,
  httpClient,
  redis,
  bullmqQueue,
  bullmqRedis,
} from "#platform/runtime.ts";
import { RedirectMap } from "#platform/http/redirect-map.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { FaviconStore } from "#features/feeds/favicon-store.ts";
import { FeedParser } from "#features/feeds/feed-parser.ts";
import { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";
import { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { OpmlImportService } from "#features/feeds/opml-import-service.ts";
import { OpmlParser } from "#features/feeds/opml-parser.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { WebSubStateService } from "#features/feeds/websub-state-service.ts";

export const articlesDataService = /* @__PURE__ */ new ArticlesDataService(
  drizzleConnection,
);
export const foldersDataService = /* @__PURE__ */ new FoldersDataService(
  drizzleConnection,
);
export const sourcesDataService = /* @__PURE__ */ new SourcesDataService(
  drizzleConnection,
);
export const websubStateService = /* @__PURE__ */ new WebSubStateService(
  drizzleConnection,
);
export const userSourcesDataService =
  /* @__PURE__ */ new UserSourcesDataService(
    drizzleConnection,
    foldersDataService,
    sourcesDataService,
  );
export const sourceEnqueuer = /* @__PURE__ */ new SourceEnqueuer(
  bullmqQueue,
  bullmqRedis,
);
export const redirectMap = /* @__PURE__ */ new RedirectMap(redis);
export const faviconStore = /* @__PURE__ */ new FaviconStore(drizzleConnection);
export const feedPreviewCache = /* @__PURE__ */ new FeedPreviewCache(redis);
export const opmlParser = /* @__PURE__ */ new OpmlParser();
export const opmlImportService = /* @__PURE__ */ new OpmlImportService(
  drizzleConnection,
  sourceEnqueuer,
);
export const feedParser = /* @__PURE__ */ new FeedParser(
  articlesDataService,
  httpClient,
  sourcesDataService,
  websubStateService,
  redirectMap,
  userSourcesDataService,
  config.FEED_FATHOM_DOMAIN,
);
