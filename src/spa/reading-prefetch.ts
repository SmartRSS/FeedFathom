import { createEffect, createRoot, on } from "solid-js";
import { maximumRequestIds } from "#shared/contracts/requests.ts";
import type { TreeNode } from "#shared/contracts/responses.ts";
import { sourceIds } from "./dashboard-behavior.ts";
import { offlineUnread } from "./preferences.ts";
import { postToWorker } from "./sw-protocol.ts";

// dashboard.tsx still imports the toggles from here.
export { offlineUnread, prefetchNext } from "./preferences.ts";

// The service worker can't read localStorage: the dashboard sends it the
// sources with unread articles, and switching offline reading off, here or in
// another tab, sends none, so the worker drops what it kept.
createRoot(() =>
  createEffect(
    on(
      offlineUnread.get,
      (enabled) => {
        if (!enabled) postOfflineSync([]);
      },
      { defer: true },
    ),
  ),
);

// The worker lists and downloads the unread articles of these sources.
export function postOfflineSync(sources: number[]) {
  postToWorker({ sources, type: "offline-sync" });
}

// Only sources with something unread are asked about. ponytail: one article
// request accepts 500 source ids, so past that many sources with unread the
// rest go undownloaded; a server-side "every subscription" unread scope
// lifts it.
export function unreadSourceIds(nodes: readonly TreeNode[]): number[] {
  return nodes
    .flatMap((node) => sourceIds(node, (source) => source.unreadCount > 0))
    .slice(0, maximumRequestIds);
}

// Save Data is the user telling every site to send fewer bytes; a
// prefetch is exactly what they asked not to receive. Browsers without
// navigator.connection (Safari, Firefox) read as "no constraint".
export function saveData(): boolean {
  // The member exists in Chromium but not in the type library.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { connection } = navigator as { connection?: { saveData?: boolean } };
  return connection?.saveData === true;
}

// The articles either side of the open one, next first: reading moves
// forward far more often than back, so that request should go out first.
export function neighbours<T>(
  items: readonly T[],
  index: number | undefined,
): T[] {
  if (index === undefined) return [];
  return [items[index + 1], items[index - 1]].filter(
    (item) => item !== undefined,
  );
}
