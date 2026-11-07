// The service worker's queue of removals made offline, in IndexedDB so it
// outlives the worker. The page clears it on logout too, for a logout the
// worker does not see (sw-protocol.ts, forgetAccountData).

export type QueuedMutation = {
  // The account that made the removal; absent only on entries queued before
  // #982, which a replay drops.
  account?: number;
  body: string;
  method: string;
  queuedAt?: number;
  trace: string | null;
  url: string;
};

export type QueueEntry = { key: IDBValidKey; value: QueuedMutation };

const QUEUE_DB = "mutation-queue";
const QUEUE_STORE = "mutations";

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(QUEUE_STORE, { autoIncrement: true });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

// Runs `run` on the store in one transaction, and resolves with what it
// returned once the transaction completes, so its requests have results.
async function queueTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => T,
): Promise<T> {
  const db = await openQueueDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, mode);
      const requests = run(tx.objectStore(QUEUE_STORE));
      tx.addEventListener("complete", () => resolve(requests));
      tx.addEventListener("error", () => reject(tx.error));
    });
  } finally {
    db.close();
  }
}

export async function queueAdd(entry: QueuedMutation): Promise<void> {
  await queueTransaction("readwrite", (store) => store.add(entry));
}

export async function queueAll(): Promise<QueueEntry[]> {
  const [keys, values] = await queueTransaction(
    "readonly",
    (store) => [store.getAllKeys(), store.getAll()] as const,
  );
  const entries: QueueEntry[] = [];
  keys.result.forEach((key, index) => {
    const value: QueuedMutation | undefined = values.result[index];
    if (value) entries.push({ key, value });
  });
  return entries;
}

export async function queueDelete(key: IDBValidKey): Promise<void> {
  await queueTransaction("readwrite", (store) => store.delete(key));
}

export async function queueClear(): Promise<void> {
  await queueTransaction("readwrite", (store) => store.clear());
}
