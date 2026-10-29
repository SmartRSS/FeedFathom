import { drizzleConnection, httpClient } from "#platform/runtime.ts";
import { sourcesDataService } from "#features/feeds/services.ts";
import { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";
import { JobFailuresDataService } from "#features/admin/job-failure-data-service.ts";

export const faviconRefresher = /* @__PURE__ */ new FaviconRefresher(
  httpClient,
  sourcesDataService,
);
export const jobFailuresDataService =
  /* @__PURE__ */ new JobFailuresDataService(drizzleConnection);
