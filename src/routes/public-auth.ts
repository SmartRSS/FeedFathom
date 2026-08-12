import { Elysia } from "elysia";
import type { AppConfig } from "../config.ts";
import type { UsersDataService } from "../db/data-services/user-data-service.ts";
import type { EmailHandler } from "../lib/email/email-handler.ts";
import type { MailSender } from "../lib/email/mail-sender.ts";
import { createActivateRoute } from "./public-auth/activate.ts";
import { createLoginRoute } from "./public-auth/login.ts";
import { createLogoutRoute } from "./public-auth/logout.ts";
import { createMailRoute } from "./public-auth/mail.ts";
import { createRegisterRoute } from "./public-auth/register.ts";
import { createSessionRoute } from "./public-auth/session.ts";

type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type PublicAuthRouteDependencies = {
  config: AppConfig;
  emailHandler: Pick<EmailHandler, "processEmail">;
  fetcher: (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch>;
  mailSender: Pick<MailSender, "sendActivationEmail">;
  password: Password;
  secureCookies: boolean;
  usersDataService: {
    activateUser(userId: number): Promise<unknown>;
    createSession(userId: number, userAgent?: null | string): Promise<string>;
    deleteSession(sid: string): Promise<void>;
    createUser(
      payload: Parameters<UsersDataService["createUser"]>[0],
    ): Promise<unknown>;
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
    findUserByActivationToken(
      token: string,
    ): ReturnType<UsersDataService["findUserByActivationToken"]>;
    getUserCount(): Promise<number>;
    getUserBySid(sid: string): ReturnType<UsersDataService["getUserBySid"]>;
  };
};

export const createPublicAuthRoutes = (deps: PublicAuthRouteDependencies) =>
  new Elysia()
    .use(createLoginRoute(deps))
    .use(createSessionRoute(deps))
    .use(createLogoutRoute(deps))
    .use(createRegisterRoute(deps))
    .use(createActivateRoute(deps))
    .use(createMailRoute(deps));
