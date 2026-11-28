export type QueuedMutation = {
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

export function isQueuedMutation(value: unknown): value is QueuedMutation {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("body" in value) ||
    typeof value.body !== "string" ||
    !("method" in value) ||
    typeof value.method !== "string" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !("trace" in value) ||
    (value.trace !== null && typeof value.trace !== "string")
  )
    return false;
  if (
    "account" in value &&
    value.account !== undefined &&
    (typeof value.account !== "number" || !Number.isSafeInteger(value.account))
  )
    return false;
  if (
    "queuedAt" in value &&
    value.queuedAt !== undefined &&
    (typeof value.queuedAt !== "number" || !Number.isFinite(value.queuedAt))
  )
    return false;
  return true;
}

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
  const rawValues: unknown = values.result;
  if (!Array.isArray(rawValues)) return entries;
  keys.result.forEach((key, index) => {
    const value: unknown = rawValues[index];
    if (isQueuedMutation(value)) entries.push({ key, value });
  });
  return entries;
}

export async function queueDelete(key: IDBValidKey): Promise<void> {
  await queueTransaction("readwrite", (store) => store.delete(key));
}

export async function queueClear(): Promise<void> {
  await queueTransaction("readwrite", (store) => store.clear());
}
