import { describe, expect, test } from "bun:test";
import type { TreeNode } from "#shared/contracts/responses.ts";
import {
  faviconUrls,
  filterTree,
  folderOpenFromStored,
  folderOpenStorageKey,
  folderOpenToStored,
  findNode,
  findParentFolderUid,
  isTodayNode,
  nextPollDelayMs,
  sourceIds,
  totalUnread,
  treeNodeKey,
  treeTabStopKey,
  unreadCount,
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
  test("returns a source's own numeric uid", () => {
    expect(sourceIds(source("42"))).toEqual([42]);
  });

  test("collects every source beneath a folder, in order", () => {
    expect(sourceIds(folder("f", [source("2"), source("9")]))).toEqual([2, 9]);
  });

  test("an empty folder contributes nothing", () => {
    expect(sourceIds(folder("f", []))).toEqual([]);
  });
});

describe("faviconUrls", () => {
  test("skips sources with no favicon", () => {
    const tree = folder("f", [
      source("1", { favicon: "https://a.example/i.png" }),
      source("2"),
    ]);
    expect(faviconUrls(tree)).toEqual(["https://a.example/i.png"]);
  });

  test("an empty favicon string is treated as absent", () => {
    expect(faviconUrls(source("1", { favicon: "" }))).toEqual([]);
  });
});

describe("unreadCount", () => {
  test("sums a folder's sources", () => {
    const tree = folder("f", [
      source("1", { unreadCount: 3 }),
      source("2", { unreadCount: 4 }),
    ]);
    expect(unreadCount(tree)).toBe(7);
  });

  test("a source reports its own count", () => {
    expect(unreadCount(source("1", { unreadCount: 5 }))).toBe(5);
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
  test("subtracts the delta for the named source", () => {
    const nodes = [source("1", { unreadCount: 5 })];
    const next = withDecrementedUnread(nodes, new Map([["1", 2]]));
    expect(unreadCount(next[0]!)).toBe(3);
  });

  test("clamps at zero rather than going negative", () => {
    const nodes = [source("1", { unreadCount: 1 })];
    const next = withDecrementedUnread(nodes, new Map([["1", 9]]));
    expect(unreadCount(next[0]!)).toBe(0);
  });

  test("reaches sources nested in a folder", () => {
    const nodes = [folder("f", [source("1", { unreadCount: 4 })])];
    const next = withDecrementedUnread(nodes, new Map([["1", 1]]));
    expect(unreadCount(next[0]!)).toBe(3);
  });

  // The component diffs on identity to decide whether to re-render, so an
  // update that changes nothing must hand back the very same array.
  test("returns the identical array when no delta applies", () => {
    const nodes = [folder("f", [source("1", { unreadCount: 4 })])];
    expect(withDecrementedUnread(nodes, new Map([["9", 1]]))).toBe(nodes);
  });

  test("leaves untouched branches identical while replacing changed ones", () => {
    const untouched = folder("keep", [source("1", { unreadCount: 2 })]);
    const nodes = [untouched, source("2", { unreadCount: 2 })];
    const next = withDecrementedUnread(nodes, new Map([["2", 1]]));
    expect(next).not.toBe(nodes);
    expect(next[0]).toBe(untouched);
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
    expect(folderOpenFromStored("open")).toBe(true);
  });

  // A folder that has never been toggled has no stored entry at all.
  test("an absent entry reads as open", () => {
    expect(folderOpenFromStored(null)).toBe(true);
  });

  // A value from an older build or a corrupted one must not hide feeds.
  test("an unrecognised value reads as open", () => {
    expect(folderOpenFromStored("")).toBe(true);
    expect(folderOpenFromStored("CLOSED")).toBe(true);
  });

  test("round-trips both states", () => {
    expect(folderOpenFromStored(folderOpenToStored(true))).toBe(true);
    expect(folderOpenFromStored(folderOpenToStored(false))).toBe(false);
  });

  test("namespaces the key by uid", () => {
    expect(folderOpenStorageKey("inbox")).toBe("folder:inbox");
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

  test("the virtual node yields no usable source id", () => {
    const node = withTodayNode([source("1")], true)[0]!;
    expect(isTodayNode(node)).toBe(true);
    // Number("today") is NaN -- which is exactly why select() must branch
    // on isTodayNode before reaching for sourceIds().
    expect(Number.isNaN(sourceIds(node)[0])).toBe(true);
  });
});
