import type { ArticleSummary, TreeNode } from "#shared/contracts/responses.ts";
import { isSnoozed } from "#shared/util/snooze.ts";

// The Today view (#715): a row in the tree that lists the last day's articles
// from every subscription. It is not a feed, so it has no id, unread count,
// feed URL or menu, and the type makes every consumer say what it does with it.
type TodayNode = { name: "Today"; type: "view"; uid: "today" };
export type ListNode = TodayNode | TreeNode;

export function treeNodeKey(node: ListNode): string {
  return `${node.type}:${node.uid}`;
}

// The ids of the sources under a node, or of those `keep` accepts.
export function sourceIds(
  node: TreeNode,
  keep: (source: Extract<TreeNode, { type: "source" }>) => boolean = () => true,
): number[] {
  if (node.type !== "source")
    return node.children.flatMap((child) => sourceIds(child, keep));
  return keep(node) ? [Number(node.uid)] : [];
}

// What one article list asks the server for. Its later pages ask the same.
export type ListScope = {
  folder?: number;
  query?: string;
  sources: number[];
  view?: "today";
};

// A folder is asked for by id and the server resolves its sources (#976):
// its source ids would run into the request's 500-id cap.
export function articleScope(node: ListNode): ListScope {
  if (node.type === "view") return { sources: [], view: node.uid };
  if (node.type === "folder") return { folder: Number(node.uid), sources: [] };
  return { sources: [Number(node.uid)] };
}

// Search answers across every subscription, so it names no source.
export const searchScope = (query: string): ListScope => ({
  query,
  sources: [],
});

export function isEmptyFolder(node: ListNode | undefined): boolean {
  return node?.type === "folder" && node.children.length === 0;
}

/**
 * The tree narrowed to what matches, case-insensitively.
 *
 * A folder whose own name matches keeps all its children -- narrowing "News"
 * to the one feed that happens to repeat the word would hide the rest of a
 * folder the user just named. A folder that does not match survives only
 * through the descendants that do.
 */
export function filterTree(nodes: ListNode[], query: string): ListNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((node) => matchingNode(node, needle) ?? []);
}

function matchingNode<N extends ListNode>(
  node: N,
  needle: string,
): N | undefined {
  if (node.name.toLowerCase().includes(needle)) return node;
  if (node.type !== "folder") return undefined;
  const children = node.children.flatMap(
    (child) => matchingNode(child, needle) ?? [],
  );
  return children.length ? { ...node, children } : undefined;
}

function hasNodeKey(nodes: ListNode[], key: string): boolean {
  return nodes.some(
    (node) =>
      treeNodeKey(node) === key ||
      (node.type === "folder" && hasNodeKey(node.children, key)),
  );
}

/**
 * The one row in the tree that is a tab stop.
 *
 * The tree is a roving tabindex, so exactly one row carries `tabindex="0"`
 * and the rest carry `-1`. The row that was last focused is that one -- until
 * a filter removes it, and a tree whose only tab stop is no longer rendered is
 * a tree Tab skips over entirely. The first row still showing takes over.
 */
export function treeTabStopKey(
  nodes: ListNode[],
  focusedKey: string | undefined,
): string | undefined {
  if (focusedKey !== undefined && hasNodeKey(nodes, focusedKey))
    return focusedKey;
  const first = nodes[0];
  return first ? treeNodeKey(first) : undefined;
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

/**
 * Per-source unread deltas for a read/unread flip, in the shape
 * `withDecrementedUnread` expects: positive shrinks the badge, negative
 * grows it. Only rows whose `read` state actually changes count -- marking
 * an already-read article read again must not touch its source's badge.
 */
export function readStateDeltas(
  items: readonly Pick<ArticleSummary, "id" | "read" | "sourceId">[],
  ids: readonly number[],
  read: boolean,
): Map<string, number> {
  const affected = new Set(ids);
  const deltas = new Map<string, number>();
  const step = read ? 1 : -1;
  for (const item of items) {
    if (!affected.has(item.id) || item.read === read) continue;
    const sourceUid = item.sourceId.toString();
    deltas.set(sourceUid, (deltas.get(sourceUid) ?? 0) + step);
  }
  return deltas;
}

export function findNode(
  nodes: ListNode[],
  type: ListNode["type"],
  uid: string,
): ListNode | undefined {
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

// Today carries no count of its own: that number would need its own server
// aggregate, and the view itself is one click away.
export function unreadCount(node: ListNode): number {
  if (node.type === "view") return 0;
  if (node.type === "source") return node.unreadCount;
  return node.children.reduce((count, child) => count + unreadCount(child), 0);
}

// Today leads the user's own tree. An empty tree has no Today: the first-run
// guidance owns that state.
export function withTodayNode(nodes: TreeNode[], enabled: boolean): ListNode[] {
  if (!enabled || nodes.length === 0) return nodes;
  return [{ name: "Today", type: "view", uid: "today" }, ...nodes];
}

export function totalUnread(nodes: TreeNode[]): number {
  return nodes.reduce((count, node) => count + unreadCount(node), 0);
}

// Per-source snooze (#725): how long each context-menu preset mutes a feed.
// "Forever" is ten years out -- far past any real pause, near enough that
// the stored timestamp stays an honest date rather than a sentinel.
export const snoozePresets = [
  { hours: 24, label: "Snooze 1 day" },
  { hours: 24 * 7, label: "Snooze 1 week" },
  { hours: 24 * 365 * 10, label: "Snooze forever" },
] as const;

/** The `pausedUntil` value to store for a preset picked now. */
export function snoozeUntilIso(
  hours: number,
  now: number = Date.now(),
): string {
  return new Date(now + hours * 3_600_000).toJSON();
}

/** Folders are never snoozed. */
export function isSnoozedNode(
  node: ListNode,
  now: number = Date.now(),
): boolean {
  return node.type === "source" && isSnoozed(node.pausedUntil, now);
}
