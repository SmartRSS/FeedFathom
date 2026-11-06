// What the page and the service worker (sw.ts) agree on: the messages they
// exchange, the request conventions only the two of them read, and the
// storage that holds one account's data. The server knows none of this,
// except the worker's served filename.

import { queueClear } from "./mutation-queue.ts";

// The page asks the worker to keep these sources' unread bodies for offline
// reading (#992); none switches it off.
type PageMessage = { sources: number[]; type: "offline-sync" };

export type WorkerMessage =
  // The server's shell names different assets than the cached one served.
  | { type: "shell-updated" }
  // A removal queued offline was refused once it replayed.
  | {
      method: string;
      status: number;
      type: "queued-mutation-failed";
      url: string;
    };

export function postToWorker(message: PageMessage): void {
  navigator.serviceWorker?.controller?.postMessage(message);
}

export function isWorkerMessage<K extends WorkerMessage["type"]>(
  data: unknown,
  type: K,
): data is Extract<WorkerMessage, { type: K }> {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === type
  );
}

// Offline reading keeps up to this many unread bodies, none older than this.
// ponytail: enough for a commute or a flight; a byte budget is the upgrade if
// bodies heavy with inline media make that too much for a phone.
export const offlineArticleLimit = 500;
export const offlineArticleMaxAgeDays = 14;

// Sent with a list request for the page after `cursor`, so the worker can
// place that cursor offline once its row has left the kept rows.
export const cursorPublishedAtHeader = "X-Cursor-Published-At";

// `/api/tree?cached` is answered from the worker's cache alone, never the
// network (#989).
export const cachedTreeQuery = "cached";

// The routes that never show the dashboard tree, so a navigation to them
// starts no /api/tree preload: the worker's, or for a page no worker controls
// yet, index.html's inline script, which vite.config.ts fills in from this.
export const treePreloadExcludedPaths =
  /^\/(admin|login|options|password-reset|preview|register|activate\/)/;

// Every cache holding one account's API responses starts with this. The
// version after it changes only to purge every entry when the caching scheme
// itself changes.
export const apiCachePrefix = "api-";

// The worker forgets the account's data on every sign-in and logout it sees
// (#974). The page repeats it for a sign-in or logout made while no worker
// controls it, as after a hard reload. A sign-in keeps the queued removals
// for their account's return, since each carries its owner (#982); a logout
// drops them.
export async function forgetAccountData(signedOut: boolean): Promise<void> {
  if (!("caches" in globalThis)) return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(apiCachePrefix))
      .map((name) => caches.delete(name)),
  );
  // A queue that can't be cleared must not block the logout.
  if (signedOut) await queueClear().catch(() => {});
}

// The worker is served under a content hash of its bundle (bin/build-spa.ts):
// a new URL is what moves clients onto a changed file, since Cloudflare can
// hold a cached copy past what Cache-Control suggests.
export const serviceWorkerFile = (hash: string) => `sw-${hash}.js`;
export const serviceWorkerPathPattern = /^\/sw-[a-f0-9]+\.js$/;
