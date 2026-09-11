import { Elysia } from "elysia";
import { createActivateRoute } from "#features/auth/routes/activate.ts";
import { createLoginRoute } from "#features/auth/routes/login.ts";
import { createLogoutRoute } from "#features/auth/routes/logout.ts";
import { createPasswordResetRoute } from "#features/auth/routes/password-reset.ts";
import { createRegisterRoute } from "#features/auth/routes/register.ts";
import { createSessionRoute } from "#features/auth/routes/session.ts";

export const createPublicAuthRoutes = (secureCookies: boolean) =>
  new Elysia()
    .use(createLoginRoute(secureCookies))
    .use(createSessionRoute())
    .use(createLogoutRoute(secureCookies))
    .use(createRegisterRoute())
    .use(createActivateRoute())
    .use(createPasswordResetRoute());
