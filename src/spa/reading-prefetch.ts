import { maximumRequestIds } from "#shared/contracts/requests.ts";
import type { Article, TreeNode } from "#shared/contracts/responses.ts";
import { sourceIds } from "./feed-tree.ts";
import { FINE_POINTER_QUERY } from "./panes.ts";
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

type ArticleRequest = (id: number, signal: AbortSignal) => Promise<Article>;
type ArticleFetch = { controller: AbortController; request: Promise<Article> };

const hoverDelayMs = 150;

/** In-flight article GETs by id, prefetches and opens alike. A press, a
 *  hover and the click that follows share one request: the service worker
 *  caches a response only once it lands, so a second GET started before
 *  then would hit the network too. Each carries its own controller, so an
 *  open can adopt it and still cancel the body when the reader moves on. */
export class ArticleFetches {
  readonly #request: ArticleRequest;
  readonly #inFlight = new Map<number, ArticleFetch>();
  #press: AbortController | undefined;
  #hoverTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(request: ArticleRequest) {
    this.#request = request;
  }

  /** The request an open awaits. Adopting it means a late pointercancel
   *  can no longer abort it. */
  open(id: number): ArticleFetch {
    this.#press = undefined;
    return this.#fetch(id);
  }

  /** Opt-in prefetch, skipped under Save Data. The plain GET is a read with
   *  no side effects; the service worker serves it for a minute without a
   *  round trip, and offline after that. */
  prefetch(id: number, openedId: number | undefined): void {
    if (!prefetchNext.get() || saveData() || openedId === id) return;
    // Best-effort: opening the article reports its own failure.
    this.#fetch(id);
  }

  /** The articles either side of the one just opened (#716, #988), next
   *  first, in idle time. */
  prefetchAround(
    rows: readonly { id: number }[],
    index: number | undefined,
    openedId: number,
  ): void {
    const targets = neighbours(rows, index);
    if (!targets.length) return;
    const run = () => {
      for (const target of targets) this.prefetch(target.id, openedId);
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run);
    else setTimeout(run, 200);
  }

  /** A plain primary press is the click's own request started early, not an
   *  extra one, so the opt-in setting doesn't apply. A press that turns into
   *  a scroll fires pointercancel, which drops the request it started. */
  press(event: PointerEvent, id: number, openedId: number | undefined): void {
    this.#press = undefined;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (saveData() || openedId === id || this.#inFlight.has(id)) return;
    this.#press = this.#fetch(id).controller;
  }

  cancelPress(): void {
    this.#press?.abort();
    this.#press = undefined;
  }

  /** A mouse resting on a row for a moment usually means a click is coming.
   *  Touch has no hover; its pointerenter arrives with the press. */
  hover(id: number, openedId: number | undefined): void {
    clearTimeout(this.#hoverTimer);
    if (!matchMedia(FINE_POINTER_QUERY).matches) return;
    this.#hoverTimer = setTimeout(
      () => this.prefetch(id, openedId),
      hoverDelayMs,
    );
  }

  leave(): void {
    clearTimeout(this.#hoverTimer);
  }

  #fetch(id: number): ArticleFetch {
    const existing = this.#inFlight.get(id);
    if (existing && !existing.controller.signal.aborted) return existing;
    const controller = new AbortController();
    const entry = { controller, request: this.#request(id, controller.signal) };
    this.#inFlight.set(id, entry);
    void entry.request
      .catch(() => {})
      .finally(() => {
        if (this.#inFlight.get(id) === entry) this.#inFlight.delete(id);
      });
    return entry;
  }
}
