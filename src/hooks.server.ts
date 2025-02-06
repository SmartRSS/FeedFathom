import { type Handle, redirect } from "@sveltejs/kit";
import container from "./container";
import { cookiesConfig } from "./util/cookies-config";

const pathsNotRequiringLogin = ["/register", "/login"];

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.dependencies = container.cradle;
  if (pathsNotRequiringLogin.includes(event.url.pathname)) {
    return resolve(event);
  }
  const sid = event.cookies.get("sid");
  const user = sid
    ? await event.locals.dependencies.usersRepository.getUserBySid(sid)
    : null;

  if (!sid || !user) {
    event.cookies.delete("sid", { path: "/" });

    return redirect(302, "/login");
  }

  event.locals.user = user;
  event.cookies.set("sid", sid, cookiesConfig);
  if (!pathsNotRequiringLogin.includes(event.url.pathname)) {
    return resolve(event);
  }
  return redirect(302, "/login");
};
