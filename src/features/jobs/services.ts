import { httpClient, redis } from "#platform/runtime.ts";
import { sourcesDataService } from "#features/feeds/services.ts";
import { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";

export const faviconRefresher = /* @__PURE__ */ new FaviconRefresher(
  httpClient,
  sourcesDataService,
  redis,
);
