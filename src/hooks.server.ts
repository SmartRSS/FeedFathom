import { type Handle, json, redirect } from "@sveltejs/kit";
import container from "./container.ts";
import { cookiesConfig } from "./util/cookies-config.ts";
import { isInternalRequest } from "./util/security.ts";
import { llog } from "./util/log.ts";

const pathsNotRequiringLogin = ["/register", "/login", "/api/mail"];

export const handle: Handle = async ({ event, resolve }) => {
  llog(event.url.pathname);
  const isInternal = isInternalRequest({
    headers: event.request.headers,
    address: event.getClientAddress(),
  });

  event.locals.dependencies = container.cradle;
  if (event.url.pathname === "/healthcheck") {
    if (!isInternal) {
      return json({ error: "Unauthorized" }, { status: 403 });
    }

    if (event.locals.dependencies.maintenanceState.isMaintenanceMode) {
      return json({ status: "down for maintenance" }, { status: 503 });
    }
    return json({ status: "ok" });
  }
  if (event.url.pathname === "/maintenance") {
    if (!isInternal) {
      return json({ error: "Unauthorized" }, { status: 403 });
    }

    event.locals.dependencies.maintenanceState.isMaintenanceMode = true;
    return json({ status: "ok" });
  }

  // Redirect empty path to root
  if (event.url.pathname === "") {
    return redirect(302, "/");
  }

  // Allow public endpoints without authentication
  if (pathsNotRequiringLogin.includes(event.url.pathname)) {
    return await resolve(event);
  }

  // Require authentication for all other endpoints
  const sid = event.cookies.get("sid");
  if (!sid) {
    event.cookies.delete("sid", { path: "/" });
    return redirect(302, "/login");
  }

  const user =
    await event.locals.dependencies.usersRepository.getUserBySid(sid);

  if (!user) {
    event.cookies.delete("sid", { path: "/" });
    return redirect(302, "/login");
  }

  event.locals.user = user;
  event.cookies.set("sid", sid, cookiesConfig);

  // Authenticated, proceed
  return await resolve(event);
};
