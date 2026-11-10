import { describe, expect, test } from "bun:test";
import {
  isDiscoveryEntry,
  parseDashboardPane,
  previousPath,
  SINGLE_PANE_QUERY,
  switchPane,
  withDashboardPane,
  withDiscovery,
} from "../panes.ts";

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

describe("Discover and return-path history state", () => {
  test("marks and clears a Discover entry, keeping the pane", () => {
    const opened = withDiscovery({ feedFathomPane: "articles" }, true);
    expect(isDiscoveryEntry(opened)).toBe(true);
    expect(parseDashboardPane(withDashboardPane(opened, "reader"))).toBe(
      "reader",
    );
    expect(isDiscoveryEntry(withDashboardPane(opened, "reader"))).toBe(true);
    expect(withDiscovery(opened, false)).toEqual({
      feedFathomPane: "articles",
    });
    for (const state of [null, {}, { feedFathomDiscovery: "yes" }])
      expect(isDiscoveryEntry(state)).toBe(false);
  });

  test("reads the address a navigation left from", () => {
    expect(previousPath({ feedFathomFrom: "/" })).toBe("/");
    for (const state of [null, {}, { feedFathomFrom: 1 }])
      expect(previousPath(state)).toBeUndefined();
  });
});

// Runs one switch against a host matching `queries`, reporting whether the
// update ran inside a view transition, outside one, or not at all.
const switchOnce = (
  queries: string[],
  options: { supported?: boolean; browserAnimated?: boolean } = {},
) => {
  let ran = "never";
  let inTransition = false;
  void switchPane(
    () => {
      ran = inTransition ? "animated" : "instant";
    },
    {
      matches: (query) => queries.includes(query),
      startViewTransition:
        options.supported === false
          ? undefined
          : (update) => {
              inTransition = true;
              update();
              inTransition = false;
              return { updateCallbackDone: Promise.resolve() };
            },
    },
    options.browserAnimated,
  );
  return ran;
};
const narrow = SINGLE_PANE_QUERY;
const reduce = "(prefers-reduced-motion: reduce)";

describe("switchPane", () => {
  test("animates on the one-pane phone layout", () => {
    expect(switchOnce([narrow])).toBe("animated");
  });

  test("stays instant wherever the animation is unwanted or unavailable", () => {
    expect(switchOnce([])).toBe("instant");
    expect(switchOnce([narrow, reduce])).toBe("instant");
    expect(switchOnce([narrow], { supported: false })).toBe("instant");
    expect(switchOnce([narrow], { browserAnimated: true })).toBe("instant");
  });
});
