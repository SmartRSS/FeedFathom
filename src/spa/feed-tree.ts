import type { ArticleSummary, TreeNode } from "#shared/contracts/responses.ts";
import { isSnoozed } from "#shared/util/snooze.ts";

type TodayNode = { name: "Today"; type: "view"; uid: "today" };
export type ListNode = TodayNode | TreeNode;

export function treeNodeKey(node: ListNode): string {
  return `${node.type}:${node.uid}`;
}

export function sourceIds(
  node: TreeNode,
  keep: (source: Extract<TreeNode, { type: "source" }>) => boolean = () => true,
): number[] {
  if (node.type !== "source")
    return node.children.flatMap((child) => sourceIds(child, keep));
  return keep(node) ? [Number(node.uid)] : [];
}

export type ListScope = {
  folder?: number;
  query?: string;
  sources: number[];
  view?: "today";
};

export function articleScope(node: ListNode): ListScope {
  if (node.type === "view") return { sources: [], view: node.uid };
  if (node.type === "folder") return { folder: Number(node.uid), sources: [] };
  return { sources: [Number(node.uid)] };
}

export const searchScope = (query: string): ListScope => ({
  query,
  sources: [],
});

export function isEmptyFolder(node: ListNode | undefined): boolean {
  return node?.type === "folder" && node.children.length === 0;
}

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

export function treeTabStopKey(
  nodes: ListNode[],
  focusedKey: string | undefined,
): string | undefined {
  if (focusedKey !== undefined && hasNodeKey(nodes, focusedKey))
    return focusedKey;
  const first = nodes[0];
  return first ? treeNodeKey(first) : undefined;
}

export function withUnreadCounts(
  nodes: TreeNode[],
  counts: ReadonlyMap<string, number>,
): TreeNode[] {
  if (counts.size === 0) return nodes;
  let changed = false;
  const next = nodes.map((node) => {
    if (node.type === "folder") {
      const children = withUnreadCounts(node.children, counts);
      if (children === node.children) return node;
      changed = true;
      return { ...node, children };
    }
    const count = counts.get(node.uid);
    if (count === undefined || count === node.unreadCount) return node;
    changed = true;
    return { ...node, unreadCount: count };
  });
  return changed ? next : nodes;
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

export function unreadCount(node: ListNode): number {
  if (node.type === "view") return 0;
  if (node.type === "source") return node.unreadCount;
  return node.children.reduce((count, child) => count + unreadCount(child), 0);
}

export function withTodayNode(nodes: TreeNode[], enabled: boolean): ListNode[] {
  if (!enabled || nodes.length === 0) return nodes;
  return [{ name: "Today", type: "view", uid: "today" }, ...nodes];
}

export function totalUnread(nodes: TreeNode[]): number {
  return nodes.reduce((count, node) => count + unreadCount(node), 0);
}

export const snoozePresets = [
  { hours: 24, label: "Snooze 1 day" },
  { hours: 24 * 7, label: "Snooze 1 week" },
  { hours: 24 * 365 * 10, label: "Snooze forever" },
] as const;

export function snoozeUntilIso(
  hours: number,
  now: number = Date.now(),
): string {
  return new Date(now + hours * 3_600_000).toJSON();
}

export function isSnoozedNode(
  node: ListNode,
  now: number = Date.now(),
): boolean {
  return node.type === "source" && isSnoozed(node.pausedUntil, now);
}
