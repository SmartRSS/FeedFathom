import type { TreeNode } from "#shared/contracts/responses.ts";

export function treeNodeKey(node: TreeNode): string {
  return `${node.type}:${node.uid}`;
}

export function sourceIds(node: TreeNode): number[] {
  return node.type === "source"
    ? [Number(node.uid)]
    : (node.children ?? []).flatMap(sourceIds);
}

export function faviconUrls(node: TreeNode): string[] {
  return node.type === "source"
    ? node.favicon
      ? [node.favicon]
      : []
    : (node.children ?? []).flatMap(faviconUrls);
}

export function withDecrementedUnread(
  nodes: TreeNode[],
  deltas: Map<string, number>,
): TreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.type === "folder") {
      const children = withDecrementedUnread(node.children, deltas);
      if (children === node.children) return node;
      changed = true;
      return { ...node, children };
    }
    const delta = deltas.get(node.uid);
    if (!delta) return node;
    changed = true;
    return { ...node, unreadCount: Math.max(0, node.unreadCount - delta) };
  });
  return changed ? next : nodes;
}

export function findNode(
  nodes: TreeNode[],
  type: TreeNode["type"],
  uid: string,
): TreeNode | undefined {
  const queue = [...nodes];
  for (const node of queue) {
    if (node.type === type && node.uid === uid) return node;
    if (node.type === "folder") queue.push(...node.children);
  }
  return undefined;
}

// Folders are flat (one level, no nesting), so a source's containing
// folder is always a direct child lookup, never a deeper search.
export function findParentFolderUid(
  nodes: TreeNode[],
  sourceUid: string,
): string | undefined {
  for (const node of nodes) {
    if (
      node.type === "folder" &&
      node.children.some(
        (child) => child.type === "source" && child.uid === sourceUid,
      )
    )
      return node.uid;
  }
  return undefined;
}

export function unreadCount(node: TreeNode): number {
  return node.type === "source"
    ? (node.unreadCount ?? 0)
    : (node.children ?? []).reduce(
        (count, child) => count + unreadCount(child),
        0,
      );
}

// The virtual "Today" view (#715): not a real source, so it never reaches
// sourceIds() or the server as an id -- callers branch on isTodayNode and
// request the view instead.
const todayNodeUid = "today";

export function isTodayNode(node: TreeNode | undefined): boolean {
  return node?.type === "source" && node.uid === todayNodeUid;
}

// Prepends the Today entry ahead of the user's own tree. Never shown on an
// empty tree (the first-run guidance owns that state), and carries no
// unread count of its own -- that number would need its own server
// aggregate, and the view itself is one click away.
export function withTodayNode(nodes: TreeNode[], enabled: boolean): TreeNode[] {
  if (!enabled || nodes.length === 0) return nodes;
  return [
    {
      favicon: null,
      homeUrl: "",
      kind: "feed",
      name: "Today",
      type: "source",
      uid: todayNodeUid,
      unreadCount: 0,
      xmlUrl: "",
    },
    ...nodes,
  ];
}

export function totalUnread(nodes: TreeNode[]): number {
  return nodes.reduce((count, node) => count + unreadCount(node), 0);
}

// Background poll spacing, backing off so a long-idle tab asks less often:
// 30s doubling to a 5-minute ceiling.
const firstPollDelayMs = 30_000;
const maxPollDelayMs = 5 * 60_000;

export function nextPollDelayMs(completedCycles: number): number {
  return Math.min(
    maxPollDelayMs,
    firstPollDelayMs * 2 ** Math.max(0, completedCycles),
  );
}

// Folder open/closed state persists as a string. Only the literal "closed"
// collapses a folder: an absent key (never toggled), a value written by an
// older build, or a corrupted one all read as open, so a bad entry can never
// hide a user's feeds.
export const folderOpenStorageKey = (uid: string) => `folder:${uid}`;

export function folderOpenFromStored(value: null | string): boolean {
  return value !== "closed";
}

export function folderOpenToStored(open: boolean): string {
  return open ? "open" : "closed";
}
