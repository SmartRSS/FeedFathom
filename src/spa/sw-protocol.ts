import { queueClear } from "./mutation-queue.ts";

type PageMessage = { sources: number[]; type: "offline-sync" };

export type WorkerMessage =
  | { type: "shell-updated" }
  | { type: "queued-mutation-failed" };

export function postOfflineSync(sources: number[]): void {
  const message: PageMessage = { sources, type: "offline-sync" };
  navigator.serviceWorker?.controller?.postMessage(message);
}

export function isPageMessage(data: unknown): data is PageMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "offline-sync" &&
    "sources" in data &&
    Array.isArray(data.sources) &&
    data.sources.every(Number.isSafeInteger)
  );
}

export function isWorkerMessage(data: unknown): data is WorkerMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data.type === "shell-updated" || data.type === "queued-mutation-failed")
  );
}

export const offlineArticleLimit = 500;
export const offlineArticleMaxAgeDays = 14;

export const cursorPublishedAtHeader = "X-Cursor-Published-At";

export const cachedTreeQuery = "cached";

export const apiCachePrefix = "api-";

export async function forgetAccountData(signedOut: boolean): Promise<void> {
  if (!("caches" in globalThis)) return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(apiCachePrefix))
      .map((name) => caches.delete(name)),
  );
  if (signedOut) await queueClear().catch(() => {});
}
