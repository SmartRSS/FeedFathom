import { maximumRequestIds } from "#shared/contracts/requests.ts";
import type { ArticleSummary, TreeNode } from "#shared/contracts/responses.ts";
import { storedToggle } from "./preferences.ts";

// Prefetching the next article's content (#716) costs the server one extra
// extract-route hit per opened article, and some users count that as waste:
// so this is off until it is switched on.
export const prefetchNext = storedToggle("prefetchNext", false);

// Offline reading (#992) downloads every recent unread body, a far larger
// bill than one prefetch, so it is off until switched on too. The service
// worker can't read localStorage: the dashboard sends it the unread rows to
// keep, which also list the articles offline, and switching off sends none.
const OFFLINE_UNREAD_KEY = "offlineUnread";
const offlineUnreadToggle = storedToggle(OFFLINE_UNREAD_KEY, false);
export const offlineUnread: typeof offlineUnreadToggle = {
  ...offlineUnreadToggle,
  set(next) {
    offlineUnreadToggle.set(next);
    if (!next) postOfflineArticles([]);
  },
};
// Another tab switching it off must stop this one's syncs too, or its next
// one would download everything again.
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === OFFLINE_UNREAD_KEY) offlineUnread.reload();
  });

// `token` tags the list requests the rows came from; an empty list carries
// none.
export function postOfflineArticles(
  articles: ArticleSummary[],
  token?: string,
) {
  navigator.serviceWorker?.controller?.postMessage({
    articles,
    token,
    type: "offline-articles",
  });
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
// prefetch is exactly what they asked not to receive. Browsers without
// navigator.connection (Safari, Firefox) read as "no constraint".
export function saveData(): boolean {
  // The member exists in Chromium but not in the type library.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { connection } = navigator as { connection?: { saveData?: boolean } };
  return connection?.saveData === true;
}

export function canRetryOfflineSync(
  enabled: boolean,
  hidden: boolean,
): boolean {
  return enabled && !hidden;
}

export function createOfflineSyncGate() {
  let syncing = false;
  let pending = false;
  return {
    finish() {
      syncing = false;
      const retry = pending;
      pending = false;
      return retry;
    },
    start() {
      if (syncing) {
        pending = true;
        return false;
      }
      syncing = true;
      return true;
    },
  };
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
