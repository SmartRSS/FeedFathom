import { config } from "#platform/config.ts";
import {
  drizzleConnection,
  httpClient,
  redis,
  bullmqQueue,
  bullmqRedis,
} from "#platform/runtime.ts";
import { RedirectMap } from "#features/feeds/redirect-map.ts";
import { ArticleEventPublisher } from "#features/feeds/article-events.ts";
import { ArticleImporter } from "#features/feeds/article-import.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";
import { FeedParser } from "#features/feeds/feed-parser.ts";
import { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";
import { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { OutboundFetchBudget } from "#features/feeds/outbound-fetch-budget.ts";
import { OpmlImportService } from "#features/feeds/opml-import-service.ts";
import { RetentionService } from "#features/feeds/retention.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import { WebSubSubscriber } from "#features/feeds/websub-subscriber.ts";

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
    sourcesDataService,
  );
export const sourceEnqueuer = /* @__PURE__ */ new SourceEnqueuer(
  bullmqQueue,
  bullmqRedis,
);
export const redirectMap = /* @__PURE__ */ new RedirectMap(redis);
export const outboundFetchBudget = /* @__PURE__ */ new OutboundFetchBudget(
  redis,
);
export const feedPreviewCache = /* @__PURE__ */ new FeedPreviewCache(redis);
export const opmlImportService = /* @__PURE__ */ new OpmlImportService(
  drizzleConnection,
  sourceEnqueuer,
  sourcesDataService,
);
const articleEventPublisher = /* @__PURE__ */ new ArticleEventPublisher(redis);
export const articleImporter = /* @__PURE__ */ new ArticleImporter(
  articlesDataService,
  userSourcesDataService,
  articleEventPublisher,
  sourcesDataService,
);
export const webSubSubscriber = /* @__PURE__ */ new WebSubSubscriber(
  websubStateService,
  httpClient,
  config.publicOrigin,
);
export const feedParser = /* @__PURE__ */ new FeedParser(
  articleImporter,
  httpClient,
  sourcesDataService,
  webSubSubscriber,
  redirectMap,
);
export const faviconRefresher = /* @__PURE__ */ new FaviconRefresher(
  httpClient,
  sourcesDataService,
  redis,
);
export const retentionService = /* @__PURE__ */ new RetentionService(
  drizzleConnection,
  userSourcesDataService,
  config,
);
