// Session restoration (#718). What the app remembers about where you were,
// and the storage it lives in. The decisions are pure and tested here; the
// dashboard owns when they fire (selection, scroll, restore).
//
// Two layers, one shape: a versioned JSON blob under one key in
// sessionStorage (survives reload) and the same blob in localStorage
// (survives across days). There is no IndexedDB in the SPA to lean on -- the
// service worker's offline queue owns its own and stays internal to sw.js --
// and a size-capped blob is all the feature needs. Reading prefers
// sessionStorage so a reload picks up the freshest snapshot; a sessionStorage
// that has expired (new tab days later) falls back to localStorage.

export const READING_SESSION_STORAGE_KEY = "feedfathom:reading-session:v1";

// The app snapshot keeps only the head of the article list (enough to
// recognise a stale restore), and the per-article reader scroll map is LRU-
// capped so a long-lived install cannot grow it without bound.
const MAX_SNAPSHOT_LIST_IDS = 20;
const MAX_READER_SCROLL_ENTRIES = 200;
const READER_SCROLL_THROTTLE_MS = 500;
const SESSION_VERSION = 1;

type ArticleFilter = "all" | "read" | "unread";

export type AppSnapshot = {
  articleFilter: ArticleFilter;
  // The article open in the reader pane when the snapshot was written.
  articleId: number | undefined;
  // Head of the list, in order, at snapshot time -- a staleness fingerprint.
  listIds: number[];
  listScrollTop: number;
  nodeType: "folder" | "source";
  nodeUid: string;
};

export type ReaderScrollEntry = {
  at: number;
  id: number;
  ratio: number;
};

export type ReadingSession = {
  app: AppSnapshot | undefined;
  reader: ReaderScrollEntry[];
};

type StorageLike = {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
};

const FILTERS: readonly ArticleFilter[] = ["all", "read", "unread"];

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// No schema library here on purpose: the blob is written and read by this one
// module, and a hand check keeps a foreign or truncated value a silent
// `undefined` -- the normal boot path -- rather than a thrown error.
export function parseReadingSession(
  raw: string | null,
): ReadingSession | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  // Version mismatch is the migration story: an older or newer blob is
  // dropped and the app boots normally. When a v2 arrives it reads v1 here
  // and reshapes it instead.
  if (record["version"] !== SESSION_VERSION) return undefined;
  const reader = parseReaderScrolls(record["reader"]);
  const app = parseAppSnapshot(record["app"]);
  if (!reader || !app) return undefined;
  return { app, reader };
}

function parseReaderScrolls(value: unknown): ReaderScrollEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ReaderScrollEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const entry = item as Record<string, unknown>;
    if (!isFiniteNumber(entry["at"]) || !isFiniteNumber(entry["id"]))
      return undefined;
    if (
      !isFiniteNumber(entry["ratio"]) ||
      entry["ratio"] < 0 ||
      entry["ratio"] > 1
    )
      return undefined;
    entries.push({ at: entry["at"], id: entry["id"], ratio: entry["ratio"] });
  }
  return entries;
}

function parseAppSnapshot(value: unknown): AppSnapshot | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const app = value as Record<string, unknown>;
  if (
    (app["nodeType"] !== "source" && app["nodeType"] !== "folder") ||
    typeof app["nodeUid"] !== "string" ||
    !FILTERS.includes(app["articleFilter"] as ArticleFilter) ||
    !isFiniteNumber(app["listScrollTop"]) ||
    !Array.isArray(app["listIds"]) ||
    !app["listIds"].every(isFiniteNumber)
  )
    return undefined;
  const articleId = app["articleId"];
  return {
    articleFilter: app["articleFilter"] as ArticleFilter,
    articleId:
      articleId === undefined || isFiniteNumber(articleId)
        ? articleId
        : undefined,
    listIds: app["listIds"],
    listScrollTop: app["listScrollTop"],
    nodeType: app["nodeType"],
    nodeUid: app["nodeUid"],
  };
}

export function serializeReadingSession(session: ReadingSession): string {
  return JSON.stringify({ ...session, version: SESSION_VERSION });
}

/** Newest first, evicting from the oldest end once over the cap. */
export function capReaderScrolls(
  entries: ReaderScrollEntry[],
  cap = MAX_READER_SCROLL_ENTRIES,
): ReaderScrollEntry[] {
  const sorted = [...entries].toSorted((a, b) => b.at - a.at);
  return sorted.length > cap ? sorted.slice(0, cap) : sorted;
}

/** Upsert one article's scroll ratio, touching its recency. */
export function recordReaderScroll(
  session: ReadingSession,
  id: number,
  ratio: number,
  at: number,
): ReadingSession {
  const clamped = Math.min(1, Math.max(0, ratio));
  const reader = capReaderScrolls([
    { at, id, ratio: clamped },
    ...session.reader.filter((entry) => entry.id !== id),
  ]);
  return { ...session, reader };
}

/** Drop reader entries (and the open-article pointer) for finished/deleted articles. */
export function clearReaderScrolls(
  session: ReadingSession,
  ids: readonly number[],
): ReadingSession {
  const gone = new Set(ids);
  const reader = session.reader.filter((entry) => !gone.has(entry.id));
  const articleId =
    session.app?.articleId !== undefined && gone.has(session.app.articleId)
      ? undefined
      : session.app?.articleId;
  return {
    app: session.app ? { ...session.app, articleId } : undefined,
    reader,
  };
}

/** Where a ratio sits in a scroll container: 0 at top, 1 at bottom. */
export function scrollRatio(element: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): number {
  const scrollable = element.scrollHeight - element.clientHeight;
  return scrollable <= 0 ? 0 : element.scrollTop / scrollable;
}

/** The inverse, clamped: content may have shifted since the ratio was taken. */
export function ratioToScrollTop(
  ratio: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const scrollable = scrollHeight - clientHeight;
  if (scrollable <= 0) return 0;
  return Math.min(scrollable, Math.max(0, ratio * scrollable));
}

// Leading-and-trailing throttle for the scroll recorders: the first event
// writes immediately, a burst coalesces into one trailing write, and a
// steady scroll writes at most once per interval. Injectable clock and
// timers, so tests never sleep.
export type ThrottleOptions = {
  intervalMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => unknown;
};

export function createThrottledRecorder<A>(
  write: (value: A) => void,
  options: ThrottleOptions = {},
): (value: A) => void {
  const intervalMs = options.intervalMs ?? READER_SCROLL_THROTTLE_MS;
  const now = options.now ?? (() => Date.now());
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let pendingHandle: unknown;
  let latest: A | undefined;
  const flush = () => {
    pendingHandle = undefined;
    lastWriteAt = now();
    if (latest !== undefined) write(latest);
    latest = undefined;
  };
  return (value: A) => {
    latest = value;
    if (pendingHandle !== undefined) return;
    const elapsed = now() - lastWriteAt;
    if (elapsed >= intervalMs) {
      flush();
      return;
    }
    pendingHandle = schedule(flush, intervalMs - elapsed);
  };
}

const emptySession = (): ReadingSession => ({ app: undefined, reader: [] });

export type ReadingSessionStoreOptions = {
  session?: StorageLike;
  local?: StorageLike;
  now?: () => number;
};

/** Owns the in-memory session and mirrors it into both storages on change. */
export class ReadingSessionStore {
  readonly #sessionStorage: StorageLike | undefined;
  readonly #localStorage: StorageLike | undefined;
  readonly #now: () => number;
  #current: ReadingSession = emptySession();

  constructor(options: ReadingSessionStoreOptions = {}) {
    this.#sessionStorage = options.session;
    this.#localStorage = options.local;
    this.#now = options.now ?? (() => Date.now());
  }

  /** sessionStorage (freshest, this tab) first, localStorage underneath. */
  load(): ReadingSession | undefined {
    for (const storage of [this.#sessionStorage, this.#localStorage]) {
      let raw: string | null = null;
      try {
        raw = storage?.getItem(READING_SESSION_STORAGE_KEY) ?? null;
      } catch {}
      const parsed = parseReadingSession(raw);
      if (parsed) {
        this.#current = parsed;
        return parsed;
      }
    }
    return undefined;
  }

  snapshot(): AppSnapshot | undefined {
    return this.load()?.app;
  }

  readerScroll(id: number): number | undefined {
    return this.#current.reader.find((entry) => entry.id === id)?.ratio;
  }

  /** Merge a partial app snapshot and persist. */
  recordApp(patch: Partial<AppSnapshot>): void {
    const base = this.#current.app ?? {
      articleFilter: "unread" as ArticleFilter,
      articleId: undefined,
      listIds: [],
      listScrollTop: 0,
      nodeType: "source" as const,
      nodeUid: "",
    };
    const listIds = patch.listIds ?? base.listIds;
    this.#current = {
      ...this.#current,
      app: {
        ...base,
        ...patch,
        listIds: listIds.slice(0, MAX_SNAPSHOT_LIST_IDS),
      },
    };
    this.#persist();
  }

  recordReaderScroll(id: number, ratio: number): void {
    this.#current = recordReaderScroll(this.#current, id, ratio, this.#now());
    this.#persist();
  }

  clearReaderScrolls(ids: readonly number[]): void {
    this.#current = clearReaderScrolls(this.#current, ids);
    this.#persist();
  }

  clear(): void {
    this.#current = emptySession();
    this.#persist();
    // An empty snapshot is no snapshot: drop the keys so "nothing stored"
    // stays true on disk, not just in memory.
    for (const storage of [this.#sessionStorage, this.#localStorage]) {
      try {
        storage?.removeItem(READING_SESSION_STORAGE_KEY);
      } catch {}
    }
  }

  #persist(): void {
    const raw = serializeReadingSession(this.#current);
    for (const storage of [this.#sessionStorage, this.#localStorage]) {
      try {
        storage?.setItem(READING_SESSION_STORAGE_KEY, raw);
      } catch {}
    }
  }
}
