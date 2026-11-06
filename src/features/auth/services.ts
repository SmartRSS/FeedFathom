import { config } from "#platform/config.ts";
import { drizzleConnection, fetcher, redis } from "#platform/runtime.ts";
import { AuthThrottle } from "./auth-throttle.ts";
import { MailSender } from "./mail-sender.ts";
import { UsersDataService } from "./user-data-service.ts";

export const authThrottle = /* @__PURE__ */ new AuthThrottle(redis);
export const mailSender = /* @__PURE__ */ new MailSender(config, fetcher);
export const usersDataService = /* @__PURE__ */ new UsersDataService(
  drizzleConnection,
);
