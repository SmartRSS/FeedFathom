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
  // Picked rather than restated, so a signature change on the service is a
  // type error here instead of two descriptions of the same method drifting
  // apart. The two exceptions are widened deliberately: their results are a
  // driver-specific execute()/insert() value that no handler reads and no
  // test double can plausibly produce.
  usersDataService: Pick<
    UsersDataService,
    | "createSession"
    | "deleteSession"
    | "findUser"
    | "findUserByActivationToken"
    | "getUserBySid"
    | "getUserCount"
  > & {
    activateUser(userId: number): Promise<unknown>;
    createUser(
      payload: Parameters<UsersDataService["createUser"]>[0],
    ): Promise<unknown>;
  };
};

export const createPublicAuthRoutes = (deps: PublicAuthRouteDependencies) =>
  new Elysia()
    .use(createLoginRoute(deps))
    .use(createSessionRoute(deps))
    .use(createLogoutRoute(deps))
    .use(createRegisterRoute(deps))
    .use(createActivateRoute(deps));
