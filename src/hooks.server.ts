import { type Handle, json, redirect } from "@sveltejs/kit";
import container from "./container.ts";
import { cookiesConfig } from "./util/cookies-config.ts";

const pathsNotRequiringLogin = ["/register", "/login"];

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.dependencies = container.cradle;
  if (event.url.pathname === "/healthcheck") {
    return json({ status: "ok" });
  }

  // Redirect empty path to root
  if (event.url.pathname === "") {
    return redirect(302, "/");
  }

  if (pathsNotRequiringLogin.includes(event.url.pathname)) {
    return await resolve(event);
  }

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
  if (!pathsNotRequiringLogin.includes(event.url.pathname)) {
    return await resolve(event);
  }

  return redirect(302, "/login");
};
