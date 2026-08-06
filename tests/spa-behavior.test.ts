import { describe, expect, test } from "bun:test";
import {
  loginPath,
  parseDashboardPane,
  registerPath,
  removalOutcome,
  resolveRoute,
  safeNextPath,
  soleSelectedIndex,
  transitionArticleSelection,
  withDashboardPane,
} from "../src/spa/behavior";

describe("dashboard pane history state", () => {
  test("parses valid pane markers", () => {
    expect(parseDashboardPane({ feedFathomPane: "sources" })).toBe("sources");
    expect(parseDashboardPane({ feedFathomPane: "articles" })).toBe("articles");
    expect(parseDashboardPane({ feedFathomPane: "reader" })).toBe("reader");
  });

  test("rejects missing or malformed pane markers", () => {
    for (const state of [
      undefined,
      null,
      "sources",
      {},
      { feedFathomPane: "other" },
      { feedFathomPane: 1 },
    ])
      expect(parseDashboardPane(state)).toBeUndefined();
  });

  test("sets the pane while preserving unrelated object state", () => {
    const state = { feedFathomPane: "sources", unrelated: { value: 1 } };
    expect(withDashboardPane(state, "reader")).toEqual({
      feedFathomPane: "reader",
      unrelated: { value: 1 },
    });
    expect(state.feedFathomPane).toBe("sources");
  });
});

describe("resolveRoute", () => {
  test("matches activation only when the token is the final path segment", () => {
    expect(resolveRoute("/activate/exact-token")).toEqual({
      name: "activate",
      token: "exact-token",
    });
    expect(resolveRoute("/activate/exact-token/extra")).toEqual({
      name: "dashboard",
    });
    expect(resolveRoute("/activate/")).toEqual({ name: "dashboard" });
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

  test("resolves named pages exactly and otherwise uses the dashboard", () => {
    expect(resolveRoute("/login")).toEqual({ name: "login", next: "/" });
    expect(resolveRoute("/register")).toEqual({
      name: "register",
      next: "/",
    });
    expect(resolveRoute("/options/more")).toEqual({ name: "dashboard" });
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

describe("transitionArticleSelection", () => {
  for (const modifier of ["ctrlKey", "metaKey"] as const) {
    test(`toggles one article with ${modifier}`, () => {
      const added = transitionArticleSelection(new Set([0]), 2, 0, {
        [modifier]: true,
      });
      expect(added).toEqual({ anchor: 2, indexes: new Set([0, 2]) });

      const removed = transitionArticleSelection(
        added.indexes,
        0,
        added.anchor,
        { [modifier]: true },
      );
      expect(removed).toEqual({ anchor: 0, indexes: new Set([2]) });
      expect(soleSelectedIndex(removed.indexes)).toBe(2);
    });
  }

  test("selects the inclusive range from the anchor", () => {
    expect(
      transitionArticleSelection(new Set([0]), 3, 1, { shiftKey: true }),
    ).toEqual({ anchor: 1, indexes: new Set([1, 2, 3]) });

    expect(
      transitionArticleSelection(new Set([0]), 3, 1, {
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toEqual({ anchor: 1, indexes: new Set([0, 1, 2, 3]) });
  });
});

describe("soleSelectedIndex", () => {
  test("chooses only a sole selection and clears for zero or many", () => {
    expect(soleSelectedIndex(new Set([2]))).toBe(2);
    expect(soleSelectedIndex(new Set())).toBeUndefined();
    expect(soleSelectedIndex(new Set([1, 2]))).toBeUndefined();
  });
});

describe("removalOutcome", () => {
  const items = ["a", "b", "c", "d", "e"];

  test("selects the item that took the removed item's place", () => {
    expect(removalOutcome(items, new Set([1]))).toEqual({
      nextIndex: 1,
      remaining: ["a", "c", "d", "e"],
    });
  });

  test("clamps to the last remaining item when the tail is removed", () => {
    expect(removalOutcome(items, new Set([3, 4]))).toEqual({
      nextIndex: 2,
      remaining: ["a", "b", "c"],
    });
  });

  test("returns an out-of-range index when every item is removed", () => {
    expect(removalOutcome(items, new Set([0, 1, 2, 3, 4]))).toEqual({
      nextIndex: -1,
      remaining: [],
    });
  });

  test("uses the lowest removed index when the selection is non-contiguous", () => {
    expect(removalOutcome(items, new Set([3, 0]))).toEqual({
      nextIndex: 0,
      remaining: ["b", "c", "e"],
    });
  });
});
