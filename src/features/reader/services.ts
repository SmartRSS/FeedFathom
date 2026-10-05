import { bullmqRedis } from "#platform/runtime.ts";
import { ArticleEventHub } from "./article-event-hub.ts";

export const articleEventHub = /* @__PURE__ */ new ArticleEventHub(() =>
  bullmqRedis.duplicate(),
);
