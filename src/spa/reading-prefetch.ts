import { maximumRequestIds } from "#shared/contracts/requests.ts";
import type { TreeNode } from "#shared/contracts/responses.ts";
import { sourceIds } from "./dashboard-behavior.ts";
import { storedToggle } from "./preferences.ts";

// Prefetching the next article's content (#716) costs the server one extra
// extract-route hit per opened article, and some users count that as waste:
// so this is off until it is switched on.
export const prefetchNext = storedToggle("prefetchNext", false);

// Offline reading (#992) downloads every recent unread body, a far larger
// bill than one prefetch, so it is off until switched on too. The service
// worker can't read localStorage: the dashboard sends it the sources with
// unread articles, and switching off sends none.
const OFFLINE_UNREAD_KEY = "offlineUnread";
const offlineUnreadToggle = storedToggle(OFFLINE_UNREAD_KEY, false);
export const offlineUnread: typeof offlineUnreadToggle = {
  ...offlineUnreadToggle,
  set(next) {
    offlineUnreadToggle.set(next);
    if (!next) postOfflineSync([]);
  },
};
// Another tab switching it off must stop this one's syncs too, or its next
// one would download everything again.
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === OFFLINE_UNREAD_KEY) offlineUnread.reload();
  });

// The worker lists and downloads the unread articles of these sources.
export function postOfflineSync(sources: number[]) {
  navigator.serviceWorker?.controller?.postMessage({
    sources,
    type: "offline-sync",
  });
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
