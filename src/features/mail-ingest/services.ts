import {
  articlesDataService,
  sourcesDataService,
  userSourcesDataService,
} from "#features/feeds/services.ts";
import { EmailHandler } from "./email-handler.ts";

export const emailHandler = /* @__PURE__ */ new EmailHandler(
  sourcesDataService,
  articlesDataService,
  userSourcesDataService,
);
