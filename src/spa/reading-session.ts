// Session restoration (#718). What the app remembers about where you were,
// and the storage it lives in.
//
// Two layers, one shape: a versioned JSON blob under one key in
// sessionStorage (survives reload) and the same blob in localStorage
// (survives across days). The page has no IndexedDB store of its own -- the
// worker's removal queue (mutation-queue.ts) owns the only one -- and a
// size-capped blob is all the feature needs. Reading prefers
// sessionStorage so a reload picks up the freshest snapshot; a sessionStorage
// that has expired (new tab days later) falls back to localStorage.

import { isArticleFilter, type ArticleFilter } from "./article-list.ts";
import { browserTimers, type Timers } from "./timers.ts";

export const READING_SESSION_STORAGE_KEY = "feedfathom:reading-session:v1";

const MAX_READER_SCROLL_ENTRIES = 200;
const READER_SCROLL_THROTTLE_MS = 500;
const SESSION_VERSION = 1;

export type AppSnapshot = {
  articleFilter: ArticleFilter;
  // The article open in the reader pane when the snapshot was written.
  articleId: number | undefined;
  listScrollTop: number;
  nodeType: "folder" | "source" | "view";
  nodeUid: string;
  // The list around the open article. Optional, so a snapshot written before
  // they existed still restores the article alone.
  anchorId?: number | undefined;
  focusedId?: number | undefined;
  // Rows loaded, so a restore pages as far as the list had been scrolled.
  loadedCount?: number | undefined;
  // The search the list showed; its node is then only the feed to go back to.
  search?: string | undefined;
  selectedIds?: number[] | undefined;
};

type ReaderScrollEntry = {
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

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
  if (!isRecord(value)) return undefined;
  // Version mismatch is the migration story: an older or newer blob is
  // dropped and the app boots normally. When a v2 arrives it reads v1 here
  // and reshapes it instead.
  if (value["version"] !== SESSION_VERSION) return undefined;
  const reader = parseReaderScrolls(value["reader"]);
  const app = parseAppSnapshot(value["app"]);
  if (!reader || (value["app"] !== undefined && !app)) return undefined;
  return { app, reader };
}

function parseReaderScrolls(value: unknown): ReaderScrollEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ReaderScrollEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    if (!isFiniteNumber(item["at"]) || !isFiniteNumber(item["id"]))
      return undefined;
    if (
      !isFiniteNumber(item["ratio"]) ||
      item["ratio"] < 0 ||
      item["ratio"] > 1
    )
      return undefined;
    entries.push({ at: item["at"], id: item["id"], ratio: item["ratio"] });
  }
  return entries;
}

function parseAppSnapshot(value: unknown): AppSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (
    (value["nodeType"] !== "source" &&
      value["nodeType"] !== "folder" &&
      value["nodeType"] !== "view") ||
    typeof value["nodeUid"] !== "string" ||
    !isArticleFilter(value["articleFilter"]) ||
    !isFiniteNumber(value["listScrollTop"])
  )
    return undefined;
  const articleId = value["articleId"];
  const optionalNumber = (key: string) =>
    isFiniteNumber(value[key]) ? value[key] : undefined;
  const selectedIds = value["selectedIds"];
  return {
    anchorId: optionalNumber("anchorId"),
    articleFilter: value["articleFilter"],
    articleId:
      articleId === undefined || isFiniteNumber(articleId)
        ? articleId
        : undefined,
    focusedId: optionalNumber("focusedId"),
    listScrollTop: value["listScrollTop"],
    loadedCount: optionalNumber("loadedCount"),
    nodeType: value["nodeType"],
    nodeUid: value["nodeUid"],
    search: typeof value["search"] === "string" ? value["search"] : undefined,
    selectedIds:
      Array.isArray(selectedIds) && selectedIds.every(isFiniteNumber)
        ? selectedIds
        : undefined,
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
// steady scroll writes at most once per interval.
export function createThrottledRecorder<A>(
  write: (value: A) => void,
  timers: Timers = browserTimers,
): (value: A) => void {
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let pendingHandle: unknown;
  let latest: A | undefined;
  const flush = () => {
    pendingHandle = undefined;
    lastWriteAt = timers.now();
    if (latest !== undefined) write(latest);
    latest = undefined;
  };
  return (value: A) => {
    latest = value;
    if (pendingHandle !== undefined) return;
    const elapsed = timers.now() - lastWriteAt;
    if (elapsed >= READER_SCROLL_THROTTLE_MS) {
      flush();
      return;
    }
    pendingHandle = timers.set(flush, READER_SCROLL_THROTTLE_MS - elapsed);
  };
}

const emptySession = (): ReadingSession => ({ app: undefined, reader: [] });

type ReadingSessionStoreOptions = {
  local: StorageLike;
  now?: () => number;
  // The "remember reading position" setting. Off, nothing is recorded.
  remember: () => boolean;
  // The first boot after reloadForUpdate(): its snapshot restores whatever
  // the setting says.
  resumingUpdate?: boolean;
  session: StorageLike;
};

/** Owns the in-memory session and mirrors it into both storages on change. */
export class ReadingSessionStore {
  readonly #sessionStorage: StorageLike;
  readonly #localStorage: StorageLike;
  readonly #now: () => number;
  readonly #remember: () => boolean;
  readonly #resumingUpdate: boolean;
  #current: ReadingSession = emptySession();

  constructor(options: ReadingSessionStoreOptions) {
    this.#sessionStorage = options.session;
    this.#localStorage = options.local;
    this.#now = options.now ?? (() => Date.now());
    this.#remember = options.remember;
    this.#resumingUpdate = options.resumingUpdate ?? false;
  }

  /** The snapshot boot restores. With the setting off, the copy an update
   *  reload left in sessionStorage is spent once read. */
  takeSnapshot(): AppSnapshot | undefined {
    const remember = this.#remember();
    const app =
      remember || this.#resumingUpdate ? this.#load()?.app : undefined;
    if (!remember) this.#remove(this.#sessionStorage);
    return app;
  }

  readerScroll(id: number): number | undefined {
    return this.#current.reader.find((entry) => entry.id === id)?.ratio;
  }

  recordApp(patch: Partial<AppSnapshot>): void {
    if (!this.#remember()) return;
    this.#mergeApp(patch);
    this.#persist();
  }

  recordReaderScroll(id: number, ratio: number): void {
    if (!this.#remember()) return;
    this.#current = recordReaderScroll(this.#current, id, ratio, this.#now());
    this.#persist();
  }

  clearReaderScrolls(ids: readonly number[]): void {
    if (!this.#remember()) return;
    this.#current = clearReaderScrolls(this.#current, ids);
    this.#persist();
  }

  /** The full snapshot an update reload resumes. With the setting off it goes
   *  to sessionStorage only, so it survives this one reload and never reaches
   *  a later launch. */
  saveBeforeReload(
    patch: Partial<AppSnapshot>,
    reader: { id: number; ratio: number } | undefined,
  ): void {
    this.#mergeApp(patch);
    if (reader)
      this.#current = recordReaderScroll(
        this.#current,
        reader.id,
        reader.ratio,
        this.#now(),
      );
    this.#persist(true);
  }

  clear(): void {
    this.#current = emptySession();
    // An empty snapshot is no snapshot: "nothing stored" holds on disk too.
    this.#remove(this.#sessionStorage);
    this.#remove(this.#localStorage);
  }

  /** sessionStorage (freshest, this tab) first, localStorage underneath. */
  #load(): ReadingSession | undefined {
    for (const storage of [this.#sessionStorage, this.#localStorage]) {
      let raw: string | null = null;
      try {
        raw = storage.getItem(READING_SESSION_STORAGE_KEY);
      } catch {}
      const parsed = parseReadingSession(raw);
      if (parsed) {
        this.#current = parsed;
        return parsed;
      }
    }
    return undefined;
  }

  #mergeApp(patch: Partial<AppSnapshot>): void {
    const base = this.#current.app ?? {
      articleFilter: "unread" as const,
      articleId: undefined,
      listScrollTop: 0,
      nodeType: "source" as const,
      nodeUid: "",
    };
    this.#current = { ...this.#current, app: { ...base, ...patch } };
  }

  #persist(force = false): void {
    const raw = serializeReadingSession(this.#current);
    const storages = this.#remember()
      ? [this.#sessionStorage, this.#localStorage]
      : force
        ? [this.#sessionStorage]
        : [];
    for (const storage of storages) {
      try {
        storage.setItem(READING_SESSION_STORAGE_KEY, raw);
      } catch {}
    }
  }

  #remove(storage: StorageLike): void {
    try {
      storage.removeItem(READING_SESSION_STORAGE_KEY);
    } catch {}
  }
}

// A reload that applies a new deploy resumes where the tab was, whatever the
// remember-position setting says: the user asked for no reload. The page
// dispatches UPDATE_RELOAD_EVENT so the dashboard writes a full snapshot, and
// the flag tells the next boot to restore it.
export const UPDATE_RELOAD_EVENT = "feedfathom:update-reload";
const UPDATE_RELOAD_KEY = "feedfathom:update-reload";

export function reloadForUpdate(): void {
  dispatchEvent(new Event(UPDATE_RELOAD_EVENT));
  try {
    sessionStorage.setItem(UPDATE_RELOAD_KEY, "1");
  } catch {}
  location.reload();
}

/** True once, on the first boot after reloadForUpdate(). */
export function takeUpdateReload(): boolean {
  try {
    const flagged = sessionStorage.getItem(UPDATE_RELOAD_KEY) !== null;
    sessionStorage.removeItem(UPDATE_RELOAD_KEY);
    return flagged;
  } catch {
    return false;
  }
}
