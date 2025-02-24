import container from "./container";
import { cookiesConfig } from "./util/cookies-config";
import { type Handle, redirect } from "@sveltejs/kit";

const pathsNotRequiringLogin = ["/register", "/login"];

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.dependencies = container.cradle;

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

  // eslint-disable-next-line require-atomic-updates
  event.locals.user = user;
  event.cookies.set("sid", sid, cookiesConfig);
  if (!pathsNotRequiringLogin.includes(event.url.pathname)) {
    return await resolve(event);
  }

  return redirect(302, "/login");
};
