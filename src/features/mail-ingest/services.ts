import { workerRequests } from "#platform/runtime.ts";
import {
  articleImporter,
  sourcesDataService,
} from "#features/feeds/services.ts";
import { EmailHandler } from "./email-handler.ts";
import { createMailRequestHandlers, MailRequests } from "./mail-requests.ts";

const emailHandler = /* @__PURE__ */ new EmailHandler(
  sourcesDataService,
  articleImporter,
);
export const mailRequests = /* @__PURE__ */ new MailRequests(workerRequests);
export const mailRequestHandlers =
  /* @__PURE__ */ createMailRequestHandlers(emailHandler);
