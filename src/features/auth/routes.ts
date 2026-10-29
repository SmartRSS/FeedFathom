import { Elysia } from "elysia";
import { createActivateRoute } from "#features/auth/routes/activate.ts";
import { createLoginRoute } from "#features/auth/routes/login.ts";
import { createLogoutRoute } from "#features/auth/routes/logout.ts";
import { createPasswordResetRoute } from "#features/auth/routes/password-reset.ts";
import { createRegisterRoute } from "#features/auth/routes/register.ts";
import { createSessionRoute } from "#features/auth/routes/session.ts";
import type { AppConfig } from "#platform/config.ts";
import type * as runtime from "#platform/runtime.ts";
import type * as auth from "#features/auth/services.ts";

export type AuthRouteServices = Pick<
  typeof auth,
  "authThrottle" | "mailSender" | "usersDataService"
> &
  Pick<typeof runtime, "fetcher" | "password"> & { config: AppConfig };

export const createPublicAuthRoutes = (
  secureCookies: boolean,
  services: AuthRouteServices,
) =>
  new Elysia()
    .use(createLoginRoute(secureCookies, services))
    .use(createSessionRoute(services))
    .use(createLogoutRoute(secureCookies, services))
    .use(createRegisterRoute(services))
    .use(createActivateRoute(services))
    .use(createPasswordResetRoute(services));
