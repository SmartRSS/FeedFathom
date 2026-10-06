import { createSignal } from "solid-js";
import { maximumRequestIds } from "#shared/contracts/requests.ts";
import type { ArticleSummary, TreeNode } from "#shared/contracts/responses.ts";

// Prefetching the next article's content (#716) costs the server one extra
// extract-route hit per opened article, and some users count that as waste:
// so this is off until it is switched on.
export type OnOff = "off" | "on";

function isOnOff(value: string): value is OnOff {
  return value === "off" || value === "on";
}

const KEY = "prefetchNext";

function read(key: string): OnOff {
  try {
    const stored = localStorage.getItem(key);
    return stored && isOnOff(stored) ? stored : "off";
  } catch {
    return "off";
  }
}

const [prefetchNextEnabled, setPrefetchNextEnabled] = createSignal<OnOff>(
  read(KEY),
);
export { prefetchNextEnabled };

export function setPrefetchNext(next: OnOff) {
  setPrefetchNextEnabled(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {}
}

// Offline reading (#992) downloads every recent unread body, a far larger
// bill than one prefetch, so it is off until switched on too. The service
// worker can't read localStorage: the dashboard sends it the unread rows to
// keep, which also list the articles offline, and switching off sends none.
const OFFLINE_UNREAD_KEY = "offlineUnread";

const [offlineUnreadEnabled, setOfflineUnreadEnabled] = createSignal<OnOff>(
  read(OFFLINE_UNREAD_KEY),
);
export { offlineUnreadEnabled };

export function postOfflineArticles(articles: ArticleSummary[]) {
  navigator.serviceWorker?.controller?.postMessage({
    articles,
    type: "offline-articles",
  });
}

export function setOfflineUnread(next: OnOff) {
  setOfflineUnreadEnabled(next);
  try {
    localStorage.setItem(OFFLINE_UNREAD_KEY, next);
  } catch {}
  if (next === "off") postOfflineArticles([]);
}

// ponytail: 500 bodies from the last 14 days. Enough for a commute or a
// flight; a byte budget is the upgrade if bodies heavy with inline media make
// that too much for a phone.
const OFFLINE_ARTICLE_LIMIT = 500;
const OFFLINE_ARTICLE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// The rows worth keeping from unread rows that arrive newest first, and
// whether the next page could add any.
export function offlineArticles<T extends Pick<ArticleSummary, "publishedAt">>(
  rows: readonly T[],
  now: number,
): { articles: T[]; complete: boolean } {
  const cutoff = now - OFFLINE_ARTICLE_MAX_AGE_MS;
  const stale = rows.findIndex(
    (row) => new Date(row.publishedAt).getTime() < cutoff,
  );
  const fresh = stale === -1 ? rows : rows.slice(0, stale);
  return {
    articles: fresh.slice(0, OFFLINE_ARTICLE_LIMIT),
    complete: stale !== -1 || fresh.length >= OFFLINE_ARTICLE_LIMIT,
  };
}

function unreadSources(node: TreeNode): number[] {
  if (node.type !== "source") return node.children.flatMap(unreadSources);
  return node.unreadCount > 0 ? [Number(node.uid)] : [];
}

// Only sources with something unread are asked about. ponytail: one article
// request accepts 500 source ids, so past that many sources with unread the
// rest go undownloaded; a server-side "every subscription" unread scope
// lifts it.
export function unreadSourceIds(nodes: readonly TreeNode[]): number[] {
  return nodes.flatMap(unreadSources).slice(0, maximumRequestIds);
}

// Save Data is the user telling every site to send fewer bytes; a
// prefetch is exactly what they asked not to receive. Unknown connection
// objects (Safari, Firefox) read as "no constraint".
export function shouldPrefetch(
  connection: { saveData?: boolean } | undefined,
): boolean {
  return !(connection?.saveData ?? false);
}

// navigator.connection is not in the standard lib types.
export function navigatorConnection(
  navigatorLike: Navigator = navigator,
): { saveData?: boolean } | undefined {
  // The assertion is the seam: the member exists in browsers but not in the
  // type library, and the function exists to read it defensively.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (navigatorLike as { connection?: { saveData?: boolean } }).connection;
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
