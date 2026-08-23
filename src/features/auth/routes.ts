import { Elysia } from "elysia";
import type { AppConfig } from "#platform/config.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import type { MailSender } from "#features/auth/mail-sender.ts";
import { createActivateRoute } from "#features/auth/routes/activate.ts";
import { createLoginRoute } from "#features/auth/routes/login.ts";
import { createLogoutRoute } from "#features/auth/routes/logout.ts";
import { createRegisterRoute } from "#features/auth/routes/register.ts";
import { createSessionRoute } from "#features/auth/routes/session.ts";

type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type PublicAuthRouteDependencies = {
  config: AppConfig;
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
    .use(createActivateRoute(deps));
