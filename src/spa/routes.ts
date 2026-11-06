import {
  activationToken,
  parsePreviewQuery,
  passwordResetToken,
  previewPathname,
} from "#shared/contracts/spa-routes.ts";

const normalizedNextPath = (value: string): string | undefined => {
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  try {
    if (decodeURIComponent(value).includes("\\")) return undefined;
    const url = new URL(value, "http://localhost");
    return url.origin === "http://localhost" &&
      url.pathname !== "/login" &&
      url.pathname !== "/register"
      ? url.pathname + url.search
      : undefined;
  } catch {
    return undefined;
  }
};

export function safeNextPath(value: string | null | undefined): string {
  return (
    (typeof value === "string" ? normalizedNextPath(value) : undefined) ?? "/"
  );
}

export function loginPath(next: string): string {
  return `/login?${new URLSearchParams({ next: safeNextPath(next) })}`;
}

export function registerPath(next: string): string {
  return `/register?${new URLSearchParams({ next: safeNextPath(next) })}`;
}

export type Route =
  | { name: "activate"; token: string }
  | { name: "login" | "register"; next: string }
  | { name: "admin" | "dashboard" | "notFound" | "options" | "passwordReset" }
  | { name: "passwordResetConfirm"; token: string }
  | { feedUrl?: string; name: "preview"; newsletter?: true };

export function resolveRoute(path: string): Route {
  const url = new URL(path, "http://localhost");
  const activation = activationToken(url.pathname);
  if (activation) return { name: "activate", token: activation };
  const reset = passwordResetToken(url.pathname);
  if (reset) return { name: "passwordResetConfirm", token: reset };

  switch (url.pathname) {
    case "/admin":
      return { name: "admin" };
    case "/login":
      return {
        name: "login",
        next: safeNextPath(url.searchParams.get("next")),
      };
    case "/options":
      return { name: "options" };
    case "/password-reset":
      return { name: "passwordReset" };
    case previewPathname:
      return { name: "preview", ...parsePreviewQuery(url.searchParams) };
    case "/register":
      return {
        name: "register",
        next: safeNextPath(url.searchParams.get("next")),
      };
    case "/":
      return { name: "dashboard" };
    default:
      return { name: "notFound" };
  }
}

// The routes that render the dashboard's panes: Discover opens over them.
export function showsPanes(route: Route): boolean {
  return route.name === "dashboard" || route.name === "preview";
}

// The paths of the routes showsPanes holds for: a navigation to one starts
// the /api/tree preload, the worker's or, for a page no worker controls yet,
// index.html's inline script, which vite.config.ts fills in from this.
export const treePreloadPaths = /^\/(preview)?$/;
