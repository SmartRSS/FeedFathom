import { describe, expect, test } from "bun:test";
import type { TreeNode } from "#shared/contracts/responses.ts";
import {
  faviconUrls,
  folderOpenFromStored,
  folderOpenStorageKey,
  folderOpenToStored,
  findNode,
  findParentFolderUid,
  sourceIds,
  treeNodeKey,
  unreadCount,
  withDecrementedUnread,
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
