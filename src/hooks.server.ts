import { type Handle, redirect } from "@sveltejs/kit";
import container from "./container";
import { cookiesConfig } from "./util/cookies-config";

const pathsNotRequiringLogin = [
  "/register",
  "/login",
  "/manifest.webmanifest",
  "/service-worker.js",
  "/favicon.ico",
];

export const handle: Handle = async ({ event, resolve }) => {
  if (pathsNotRequiringLogin.includes(event.url.pathname)) {
    return resolve(event);
  }
  event.locals.dependencies = container.cradle;
  const sid = event.cookies.get("sid");
  const user = sid
    ? await event.locals.dependencies.usersRepository.getUserBySid(sid)
    : null;

  if (!sid || !user) {
    event.cookies.delete("sid", { path: "/" });

    return redirect(302, "/login");
  }

  event.locals.user = user ?? undefined;
  event.cookies.set("sid", sid, cookiesConfig);
  if (user && !pathsNotRequiringLogin.includes(event.url.pathname)) {
    return resolve(event);
  }
  return redirect(302, "/login");
};
