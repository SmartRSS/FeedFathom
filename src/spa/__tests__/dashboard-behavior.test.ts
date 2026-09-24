import { describe, expect, test } from "bun:test";
import type { TreeNode } from "#shared/contracts/responses.ts";
import {
  faviconUrls,
  filterTree,
  folderOpenFromStored,
  folderOpenToStored,
  findNode,
  findParentFolderUid,
  isSnoozedNode,
  isTodayNode,
  preloadFavicons,
  nextPollDelayMs,
  sourceIds,
  snoozeUntilIso,
  totalUnread,
  treeNodeKey,
  treeTabStopKey,
  withDecrementedUnread,
  withTodayNode,
} from "../dashboard-behavior.ts";

function source(
  uid: string,
  overrides: Partial<Extract<TreeNode, { type: "source" }>> = {},
): TreeNode {
  return {
    favicon: null,
    homeUrl: `https://${uid}.example`,
    kind: "feed",
    name: uid,
    type: "source",
    uid,
    unreadCount: 0,
    xmlUrl: `https://${uid}.example/feed`,
    ...overrides,
  };
}

function folder(uid: string, children: TreeNode[]): TreeNode {
  return { children, name: uid, type: "folder", uid };
}

describe("treeNodeKey", () => {
  test("qualifies the uid with the node type", () => {
    expect(treeNodeKey(source("7"))).toBe("source:7");
    expect(treeNodeKey(folder("7", []))).toBe("folder:7");
  });
});

describe("sourceIds", () => {
  test("collects source IDs in order through nested and empty folders", () => {
    expect(
      sourceIds(
        folder("f", [
          source("2"),
          folder("nested", [source("9")]),
          folder("empty", []),
        ]),
      ),
    ).toEqual([2, 9]);
    expect(sourceIds(folder("empty", []))).toEqual([]);
  });
});

describe("preloadFavicons", () => {
  test("stops waiting for a favicon that never settles", async () => {
    const tree = [source("1", { favicon: "https://hang.example/i.png" })];
    const started = performance.now();
    await preloadFavicons(tree, () => new Promise(() => {}));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("faviconUrls", () => {
  test("collects favicons and skips missing or empty values", () => {
    const tree = folder("f", [
      source("1", { favicon: "https://a.example/i.png" }),
      source("2"),
      source("3", { favicon: "" }),
    ]);
    expect(faviconUrls(tree)).toEqual(["https://a.example/i.png"]);
  });
});

describe("totalUnread", () => {
  test("sums every root, folders included", () => {
    const nodes = [
      source("1", { unreadCount: 3 }),
      folder("f", [source("2", { unreadCount: 4 })]),
    ];
    expect(totalUnread(nodes)).toBe(7);
  });

  test("an empty tree reads as zero", () => {
    expect(totalUnread([])).toBe(0);
  });
});

describe("nextPollDelayMs", () => {
  test("starts at 30 seconds and doubles to a 5-minute ceiling", () => {
    expect(nextPollDelayMs(0)).toBe(30_000);
    expect(nextPollDelayMs(1)).toBe(60_000);
    expect(nextPollDelayMs(2)).toBe(120_000);
    expect(nextPollDelayMs(3)).toBe(240_000);
    expect(nextPollDelayMs(4)).toBe(300_000);
    expect(nextPollDelayMs(5)).toBe(300_000);
    expect(nextPollDelayMs(50)).toBe(300_000);
  });

  test("negative attempt counts read as the first interval", () => {
    expect(nextPollDelayMs(-1)).toBe(30_000);
  });
});

describe("withDecrementedUnread", () => {
  test("decrements nested sources, clamps at zero, and preserves untouched branches", () => {
    const untouched = folder("keep", [source("3", { unreadCount: 2 })]);
    const nodes = [
      folder("f", [
        source("1", { unreadCount: 5 }),
        source("2", { unreadCount: 1 }),
      ]),
      untouched,
    ];
    const next = withDecrementedUnread(
      nodes,
      new Map([
        ["1", 2],
        ["2", 9],
      ]),
    );
    expect(next).toEqual([
      folder("f", [
        source("1", { unreadCount: 3 }),
        source("2", { unreadCount: 0 }),
      ]),
      untouched,
    ]);
    expect(next).not.toBe(nodes);
    expect(next[1]).toBe(untouched);
    expect(totalUnread(nodes)).toBe(8);
  });

  // The component diffs on identity to decide whether to re-render, so an
  // update that changes nothing must hand back the very same array.
  test("returns the identical array when no delta applies", () => {
    const nodes = [folder("f", [source("1", { unreadCount: 4 })])];
    expect(withDecrementedUnread(nodes, new Map([["9", 1]]))).toBe(nodes);
  });

  test("a zero delta counts as no change", () => {
    const nodes = [source("1", { unreadCount: 4 })];
    expect(withDecrementedUnread(nodes, new Map([["1", 0]]))).toBe(nodes);
  });
});

describe("findNode", () => {
  test("finds a source nested inside a folder", () => {
    const nodes = [folder("f", [source("1")])];
    expect(findNode(nodes, "source", "1")?.name).toBe("1");
  });

  test("matches on type as well as uid", () => {
    const nodes = [folder("7", []), source("7")];
    expect(findNode(nodes, "source", "7")?.type).toBe("source");
  });

  test("returns undefined when nothing matches", () => {
    expect(findNode([source("1")], "source", "2")).toBeUndefined();
  });
});

describe("findParentFolderUid", () => {
  test("names the folder holding the source", () => {
    const nodes = [folder("inbox", [source("1")])];
    expect(findParentFolderUid(nodes, "1")).toBe("inbox");
  });

  test("a source at the root has no parent folder", () => {
    expect(findParentFolderUid([source("1")], "1")).toBeUndefined();
  });
});

describe("folder open persistence", () => {
  test('only the literal "closed" collapses a folder', () => {
    expect(folderOpenFromStored("closed")).toBe(false);
    for (const value of ["open", null, "", "CLOSED"])
      expect(folderOpenFromStored(value)).toBe(true);
  });

  test("serializes both folder states", () => {
    expect(folderOpenToStored(true)).toBe("open");
    expect(folderOpenToStored(false)).toBe("closed");
  });
});

describe("filterTree", () => {
  const tree = [
    folder("News", [
      source("bbc", { name: "BBC World" }),
      source("ap", { name: "Associated Press" }),
    ]),
    folder("Tech", [source("lwn", { name: "LWN" })]),
    source("loose", { name: "Daily Newsletter" }),
  ];

  test("keeps a matching source and the folder it lives in", () => {
    expect(filterTree(tree, "lwn")).toEqual([
      folder("Tech", [source("lwn", { name: "LWN" })]),
    ]);
  });

  test("keeps every child of a folder whose own name matches", () => {
    // Narrowing to the one child that repeats the folder's word would hide
    // the rest of a folder the user just named, which is not what "filter to
    // News" asks for.
    expect(filterTree(tree, "news")).toEqual([
      folder("News", [
        source("bbc", { name: "BBC World" }),
        source("ap", { name: "Associated Press" }),
      ]),
      source("loose", { name: "Daily Newsletter" }),
    ]);
  });

  test("drops a folder no descendant matches, and returns the tree unfiltered for a blank query", () => {
    expect(filterTree(tree, "nothing here")).toEqual([]);
    expect(filterTree(tree, "   ")).toBe(tree);
  });
});

describe("treeTabStopKey", () => {
  const tree = [
    folder("News", [source("bbc")]),
    folder("Tech", [source("lwn")]),
  ];

  test("keeps the focused row as the tab stop while it is still shown", () => {
    expect(treeTabStopKey(tree, "source:lwn")).toBe("source:lwn");
    expect(treeTabStopKey(tree, "folder:News")).toBe("folder:News");
  });

  test("falls back to the first row when the focused one is filtered away", () => {
    // The tree is a roving tabindex: exactly one row is a tab stop. Filtering
    // out the row that had it would otherwise leave none, and Tab would skip
    // the whole tree.
    expect(
      treeTabStopKey([folder("News", [source("bbc")])], "source:lwn"),
    ).toBe("folder:News");
    expect(treeTabStopKey(tree, undefined)).toBe("folder:News");
  });

  test("has no tab stop to offer for an empty tree", () => {
    expect(treeTabStopKey([], "source:lwn")).toBeUndefined();
  });
});

describe("withTodayNode", () => {
  test("prepends the virtual node ahead of the user's tree", () => {
    const nodes = [source("1")];
    const next = withTodayNode(nodes, true);
    expect(next).toHaveLength(2);
    expect(isTodayNode(next[0])).toBe(true);
    expect(next[1]).toBe(nodes[0]);
    expect(next[0]!.type === "source" && next[0]!.name).toBe("Today");
  });

  test("leaves an empty tree alone so first-run guidance owns it", () => {
    expect(withTodayNode([], true)).toEqual([]);
  });

  test("disabled drops the node entirely", () => {
    expect(withTodayNode([source("1")], false)).toHaveLength(1);
  });
});

describe("source snooze", () => {
  const now = new Date("2026-09-09T12:00:00.000Z").getTime();

  test("a future pausedUntil reads as snoozed", () => {
    expect(
      isSnoozedNode(
        source("1", { pausedUntil: "2026-09-10T12:00:00.000Z" }),
        now,
      ),
    ).toBe(true);
  });

  test("a missing or past pausedUntil reads as not snoozed", () => {
    expect(isSnoozedNode(source("1"), now)).toBe(false);
    expect(isSnoozedNode(source("1", { pausedUntil: null }), now)).toBe(false);
    expect(
      isSnoozedNode(
        source("1", { pausedUntil: "2026-09-08T12:00:00.000Z" }),
        now,
      ),
    ).toBe(false);
  });

  test("converts snooze durations from hours to absolute timestamps", () => {
    expect(snoozeUntilIso(24, now)).toBe("2026-09-10T12:00:00.000Z");
    expect(snoozeUntilIso(168, now)).toBe("2026-09-16T12:00:00.000Z");
  });
});
