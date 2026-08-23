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
