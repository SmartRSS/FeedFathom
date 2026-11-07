import { describe, expect, test } from "bun:test";
import {
  activationPath,
  passwordResetPath,
  previewPath,
} from "#shared/contracts/spa-routes.ts";
import {
  loginPath,
  registerPath,
  resolveRoute,
  safeNextPath,
  showsPanes,
  treePreloadPaths,
} from "../routes.ts";

describe("resolveRoute", () => {
  test("matches activation only when the token is the final path segment", () => {
    expect(resolveRoute("/activate/exact-token")).toEqual({
      name: "activate",
      token: "exact-token",
    });
    expect(resolveRoute("/activate/exact-token/extra")).toEqual({
      name: "notFound",
    });
    expect(resolveRoute("/activate/")).toEqual({ name: "notFound" });
  });

  test("prefills preview from its decoded feedUrl query", () => {
    expect(
      resolveRoute(
        "/preview?feedUrl=https%3A%2F%2Fexample.com%2Ffeed.xml%3Fx%3D1",
      ),
    ).toEqual({
      feedUrl: "https://example.com/feed.xml?x=1",
      name: "preview",
    });
    expect(resolveRoute("/preview")).toEqual({ name: "preview" });
  });

  test("asks the preview page to mint a newsletter address", () => {
    expect(resolveRoute("/preview?newsletter")).toEqual({
      name: "preview",
      newsletter: true,
    });
  });

  test("requires an exact match for named pages", () => {
    expect(resolveRoute("/options")).toEqual({ name: "options" });
    expect(resolveRoute("/options/more")).toEqual({ name: "notFound" });
    expect(resolveRoute("/no/such/page")).toEqual({ name: "notFound" });
    expect(resolveRoute("/?feed=1")).toEqual({ name: "dashboard" });
  });
});

// The server and the extension build these links; the SPA must route them.
test("routes every link another program builds", () => {
  expect(resolveRoute(activationPath("a-token"))).toEqual({
    name: "activate",
    token: "a-token",
  });
  expect(resolveRoute(passwordResetPath("r-token"))).toEqual({
    name: "passwordResetConfirm",
    token: "r-token",
  });
  expect(
    resolveRoute(previewPath({ feedUrl: "https://example.com/f?a=1&b" })),
  ).toEqual({ feedUrl: "https://example.com/f?a=1&b", name: "preview" });
  expect(resolveRoute(previewPath({ newsletter: true }))).toEqual({
    name: "preview",
    newsletter: true,
  });
});

describe("safe account destinations", () => {
  test("round-trips a preview URL through login, register, and login", () => {
    const next =
      "/preview?feedUrl=https%3A%2F%2Fexample.com%2Ffeed.xml%3Ftopic%3Done%26label%3Da%2Bb";
    const initialLoginPath = loginPath(next);
    const loginRoute = resolveRoute(initialLoginPath);
    expect(initialLoginPath).toBe(`/login?next=${encodeURIComponent(next)}`);
    expect(loginRoute).toEqual({ name: "login", next });
    if (loginRoute.name !== "login") throw new Error("Expected login route");

    const registrationRoute = resolveRoute(registerPath(loginRoute.next));
    expect(registrationRoute).toEqual({ name: "register", next });
    if (registrationRoute.name !== "register")
      throw new Error("Expected register route");

    expect(loginPath(registrationRoute.next)).toBe(initialLoginPath);
  });

  test("defaults direct account routes to root", () => {
    expect(resolveRoute("/login")).toEqual({ name: "login", next: "/" });
    expect(resolveRoute("/register")).toEqual({
      name: "register",
      next: "/",
    });
    expect(registerPath("/")).toBe("/register?next=%2F");
    expect(loginPath("/")).toBe("/login?next=%2F");
  });

  test("rejects an unsafe register destination", () => {
    expect(
      resolveRoute(`/register?next=${encodeURIComponent("//example.com")}`),
    ).toEqual({ name: "register", next: "/" });
  });

  test("preserves URL special characters", () => {
    expect(safeNextPath("/search?q=one%20%26%20two&tag=a%2Bb#ignored")).toBe(
      "/search?q=one%20%26%20two&tag=a%2Bb",
    );
  });

  test("accepts root-relative internal paths", () => {
    for (const path of ["/", "/options", "/preview?feedUrl=news@example.com"])
      expect(safeNextPath(path)).toBe(path);
  });

  test("rejects unsafe, malformed, and login-loop destinations", () => {
    for (const path of [
      null,
      undefined,
      "",
      "dashboard",
      "https://example.com/dashboard",
      "//example.com/dashboard",
      "\\example.com\\dashboard",
      "/\\example.com/dashboard",
      "/%5Cexample.com/dashboard",
      "/bad%2",
      "/login",
      "/login?next=%2Fpreview",
      "/register",
      "/register?next=%2Fpreview",
      "/dashboard/../login",
      "/dashboard/../register",
    ])
      expect(safeNextPath(path)).toBe("/");
  });
});

test("only the dashboard and Discover show the panes", () => {
  expect(showsPanes(resolveRoute("/"))).toBe(true);
  expect(showsPanes(resolveRoute("/preview?feedUrl=x"))).toBe(true);
  expect(showsPanes(resolveRoute("/options"))).toBe(false);
  expect(showsPanes(resolveRoute("/nowhere"))).toBe(false);
});

// A miss costs the dashboard an unpreloaded /api/tree; an extra one spends
// a request nothing reads, or a 401 before sign-in.
test.each([
  "/",
  "/preview",
  "/admin",
  "/login",
  "/register",
  "/options",
  "/password-reset",
  "/password-reset/token",
  "/activate/token",
  "/no/such/page",
  "/previews",
])("preloads the tree for %s exactly when it shows the panes", (path) => {
  expect(treePreloadPaths.test(path)).toBe(showsPanes(resolveRoute(path)));
});
