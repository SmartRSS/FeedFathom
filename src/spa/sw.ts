import type { Static, StaticEncode } from "typebox";
import { articlePageSize, todayWindowHours } from "#shared/contracts/limits.ts";
import type {
  articlesRequest,
  removeArticlesRequest,
  removeFolderRequest,
  removeSourceRequest,
} from "#shared/contracts/requests.ts";
import type {
  ArticleSummary,
  sessionResponse,
  TreeNode,
  treeResponse,
} from "#shared/contracts/responses.ts";
import { findNode, sourceIds } from "./feed-tree.ts";
import { deleteTraceHeader, replayHeader } from "#shared/contracts/headers.ts";
import {
  queueAdd,
  queueAll,
  queueDelete,
  type QueueEntry,
  type QueuedMutation,
} from "./mutation-queue.ts";
import {
  apiCachePrefix,
  cachedTreeQuery,
  cursorPublishedAtHeader,
  forgetAccountData,
  isPageMessage,
  offlineArticleLimit,
  offlineArticleMaxAgeDays,
  type WorkerMessage,
} from "./sw-protocol.ts";
import { treePreloadPaths } from "./routes.ts";

type ExtendableEvent = { waitUntil(promise: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & {
  request: Request;
  respondWith(response: Promise<Response>): void;
};
type MessageEvent = ExtendableEvent & { data: unknown };
type SyncEvent = ExtendableEvent & { tag: string };
type WindowClient = {
  postMessage(message: WorkerMessage): void;
  visibilityState: DocumentVisibilityState;
};
type WorkerScope = {
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(
    type: "install" | "activate",
    listener: (event: ExtendableEvent) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  addEventListener(type: "sync", listener: (event: SyncEvent) => void): void;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window" }): Promise<readonly WindowClient[]>;
  };
  location: { origin: string };
  registration: { sync?: { register(tag: string): Promise<void> } };
  skipWaiting(): Promise<void>;
};

function isWorkerScope(scope: object): scope is WorkerScope {
  return "clients" in scope && "registration" in scope;
}

if (!isWorkerScope(self))
  throw new Error("sw.ts runs only as a service worker.");
const worker: WorkerScope = self;

type ArticlesRequest = StaticEncode<typeof articlesRequest>;
type OfflineRow = Pick<
  ArticleSummary,
  "id" | "publishedAt" | "revision" | "sourceId"
>;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the cast
function uncheckedJson<T>(text: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-return -- contract types, read unchecked to keep typebox out of the worker
  return JSON.parse(text);
}

const CACHE_VERSION = "v7";
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const API_CACHE = `${apiCachePrefix}${CACHE_VERSION}`;
const SHELL_REQUEST_INIT: RequestInit = {
  credentials: "same-origin",
  headers: { Accept: "text/html" },
};

type Removals = {
  "/api/articles": StaticEncode<typeof removeArticlesRequest>;
  "/api/folders": StaticEncode<typeof removeFolderRequest>;
  "/api/source": StaticEncode<typeof removeSourceRequest>;
};
const QUEUEABLE_REMOVALS: { [P in keyof Removals]: keyof Removals[P] } = {
  "/api/articles": "removedArticleIdList",
  "/api/folders": "removeFolderId",
  "/api/source": "removeSourceId",
};

function queueableRemoval(path: string): keyof Removals | undefined {
  return Object.keys(QUEUEABLE_REMOVALS).find(
    (removal): removal is keyof Removals => removal === path,
  );
}

function echoedRemoval(path: keyof Removals, body: string): unknown {
  const parsed = uncheckedJson<Record<string, unknown>>(body);
  return parsed[QUEUEABLE_REMOVALS[path]];
}

function shellAssetUrls(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
}

async function putShell(cache: Cache, response: Response): Promise<string[]> {
  const assetUrls = shellAssetUrls(await response.clone().text());
  await Promise.all(
    assetUrls.map(async (url) => {
      if (await cache.match(url)) return;
      try {
        const assetResponse = await fetch(url);
        if (assetResponse.ok) await cache.put(url, assetResponse);
      } catch {}
    }),
  );
  await cache.put("/", response);
  return assetUrls;
}

worker.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch("/", SHELL_REQUEST_INIT);
      if (response.ok) await putShell(await caches.open(SHELL_CACHE), response);
    })(),
  );
  void worker.skipWaiting();
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key)),
      );
      await purgeHeaderlessFavicons();
      await worker.clients.claim();
      await flushQueue();
    })(),
  );
});

async function deleteWhere(cache: Cache, stale: (url: URL) => boolean) {
  const keys = (await cache.keys()).filter((key) => stale(new URL(key.url)));
  await Promise.all(keys.map((key) => cache.delete(key)));
}

const FAVICON_PURGE_MARKER = "/sw-favicon-headers-purged";
async function purgeHeaderlessFavicons() {
  const cache = await caches.open(API_CACHE);
  if (await cache.match(FAVICON_PURGE_MARKER)) return;
  await deleteWhere(cache, (url) => url.pathname.startsWith("/api/favicon/"));
  await cache.put(FAVICON_PURGE_MARKER, new Response(""));
}

worker.addEventListener("sync", (event) => {
  if (event.tag === "replay-mutations") event.waitUntil(flushQueue());
});

let queueMayHaveEntries = true;

async function notifyClients(message: WorkerMessage) {
  const clients = await worker.clients.matchAll({ type: "window" });
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Client.postMessage takes no target origin
  for (const client of clients) client.postMessage(message);
}

const SESSION_PATH = "/api/session";
const ACCOUNT_KEY = "/sw-queue-account";

async function cachedAccount(): Promise<number | undefined> {
  try {
    const cached = await (await caches.open(API_CACHE)).match(ACCOUNT_KEY);
    const record = cached
      ? uncheckedJson<{ id?: number }>(await cached.text())
      : undefined;
    return record?.id;
  } catch {
    return undefined;
  }
}

let accountChanges = 0;

let pendingLookup:
  | { generation: number; lookup: Promise<number | undefined> }
  | undefined;

async function sessionAccount(generation: number) {
  try {
    const response = await fetch(SESSION_PATH, { credentials: "same-origin" });
    if (!response.ok) return undefined;
    const session = uncheckedJson<Static<typeof sessionResponse>>(
      await response.text(),
    );
    const id = session.user?.id;
    const cache = await caches.open(API_CACHE);
    if (generation !== accountChanges) return undefined;
    if (id !== undefined) await cache.put(ACCOUNT_KEY, Response.json({ id }));
    return id;
  } catch {
    return undefined;
  }
}

let replaying: Promise<void> = Promise.resolve();
let replayPending = false;
function flushQueue(): Promise<void> {
  if (replayPending) return replaying;
  replayPending = true;
  replaying = replaying
    .catch(() => {})
    .then(() => {
      replayPending = false;
      return replayQueue();
    });
  return replaying;
}

const isRefusal = (status: number) =>
  status >= 400 && status < 500 && status !== 401;

async function replayEntry(
  { key, value }: QueueEntry,
  account: number,
): Promise<boolean> {
  if (value.account !== account) {
    await queueDelete(key);
    return true;
  }
  const response = await fetch(value.url, {
    body: value.body,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      [replayHeader]: String(value.queuedAt ?? "unknown"),
      ...(value.trace ? { [deleteTraceHeader]: value.trace } : {}),
    },
    method: value.method,
  });
  if (response.ok) {
    await queueDelete(key);
    return true;
  }
  if (!isRefusal(response.status)) return false;
  await queueDelete(key);
  await notifyClients({ type: "queued-mutation-failed" }).catch(() => {});
  return true;
}

async function replayQueue() {
  if (!queueMayHaveEntries) return;
  queueMayHaveEntries = false;
  const generation = accountChanges;
  let entries: QueueEntry[];
  try {
    entries = await queueAll();
  } catch (error) {
    queueMayHaveEntries = true;
    throw error;
  }
  if (entries.length === 0 && (await cachedAccount()) !== undefined) return;
  const lookup = sessionAccount(generation);
  pendingLookup = { generation, lookup };
  const account = await lookup;
  if (account === undefined) {
    queueMayHaveEntries = true;
    return;
  }
  for (const entry of entries) {
    let sent = false;
    try {
      if (generation === accountChanges)
        // oxlint-disable-next-line no-await-in-loop -- replay must preserve order
        sent = await replayEntry(entry, account);
    } catch {
      sent = false;
    }
    if (!sent) {
      queueMayHaveEntries = true;
      break;
    }
  }
}

async function ownerAccount() {
  const generation = accountChanges;
  const pending = pendingLookup;
  const cached = await cachedAccount();
  if (cached !== undefined) return cached;
  return pending?.generation === generation ? await pending.lookup : undefined;
}

async function queueableMutation(request: Request, path: keyof Removals) {
  const owner = ownerAccount();
  try {
    return await fetch(request.clone());
  } catch (error) {
    const account = await owner;
    if (account === undefined) throw error;
    const body = await request.text();
    const entry: QueuedMutation = {
      account,
      body,
      method: request.method,
      queuedAt: Date.now(),
      trace: request.headers.get(deleteTraceHeader),
      url: request.url,
    };
    await queueAdd(entry);
    queueMayHaveEntries = true;
    try {
      await worker.registration.sync?.register("replay-mutations");
    } catch {}
    return Response.json(echoedRemoval(path, body));
  }
}

async function cacheFirst(
  event: ExtendableEvent,
  request: Request,
  cacheName: string,
  init?: RequestInit,
) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request, init);
  if (response.ok) event.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function changeAccount(request: Request, signedOut: boolean) {
  accountChanges++;
  const response = await fetch(request);
  if (response.ok) {
    accountChanges++;
    treePreload = undefined;
    await forgetAccountData(signedOut);
    queueMayHaveEntries = true;
  }
  return response;
}

async function networkFirst(
  event: ExtendableEvent,
  request: Request,
  network = fetch(request),
) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await network;
    if (response.ok) {
      const { pathname, search } = new URL(request.url);
      event.waitUntil(
        (async () => {
          await cache.put(request, response.clone());
          if (search) await trimPath(cache, pathname, QUERY_CACHE_LIMIT);
        })(),
      );
      event.waitUntil(flushQueue());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

const FETCHED_AT = "X-SW-Fetched-At";

function withHeader(response: Response, name: string, value: string) {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

const ARTICLE_FRESH_MS = 60 * 1000;
const ARTICLE_CACHE_LIMIT = 200;

const QUERY_CACHE_LIMIT = 20;

async function trimPath(cache: Cache, pathname: string, limit: number) {
  const entries = (await cache.keys()).filter(
    (request) => new URL(request.url).pathname === pathname,
  );
  await Promise.all(
    entries.slice(0, -limit).map((request) => cache.delete(request)),
  );
}

async function recentArticleFirst(event: ExtendableEvent, request: Request) {
  const cache = await caches.open(API_CACHE);
  const downloaded = await cache.match(
    offlineArticleKey(new URL(request.url).searchParams.get("article")),
  );
  if (downloaded) return downloaded;
  const cached = await cache.match(request);
  const fetchedAt = Number(cached?.headers.get(FETCHED_AT));
  if (cached && Date.now() - fetchedAt < ARTICLE_FRESH_MS) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const stamped = withHeader(response.clone(), FETCHED_AT, `${Date.now()}`);
      event.waitUntil(
        (async () => {
          await cache.put(request, stamped);
          await trimPath(cache, "/api/article", ARTICLE_CACHE_LIMIT);
        })(),
      );
      event.waitUntil(flushQueue());
    }
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

const OFFLINE_ARTICLE_PATH = "/sw-offline-article";
const OFFLINE_LIST_KEY = "/sw-offline-articles";
const offlineArticleKey = (id: number | string | null) =>
  `${OFFLINE_ARTICLE_PATH}?article=${id}`;
const OFFLINE_VERSION = "X-SW-Version";
const OFFLINE_ARTICLE_MAX_AGE_MS = offlineArticleMaxAgeDays * 24 * 60 * 60_000;

let offlineSyncs = 0;
let offlineQueue: Promise<void> = Promise.resolve();
let offlineDownloads = new AbortController();

async function anyVisibleClient() {
  const clients = await worker.clients.matchAll({ type: "window" });
  return clients.some((client) => client.visibilityState === "visible");
}

async function listOfflineRows(sources: number[], signal: AbortSignal) {
  const cutoff = Date.now() - OFFLINE_ARTICLE_MAX_AGE_MS;
  const rows: OfflineRow[] = [];
  while (sources.length > 0) {
    const last = rows.at(-1);
    const body: ArticlesRequest = {
      filter: "unread",
      revision: true,
      sources,
      ...(last ? { cursor: last.id } : {}),
    };
    // oxlint-disable-next-line no-await-in-loop -- keyset pages are sequential
    const response = await fetch("/api/articles", {
      body: JSON.stringify(body),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal,
    });
    if (!response.ok) throw new Error(`article list ${response.status}`);
    // oxlint-disable-next-line no-await-in-loop -- keyset pages are sequential
    const page = uncheckedJson<OfflineRow[]>(await response.text());
    const stale = page.findIndex((row) => Date.parse(row.publishedAt) < cutoff);
    rows.push(...(stale === -1 ? page : page.slice(0, stale)));
    if (
      stale !== -1 ||
      rows.length >= offlineArticleLimit ||
      page.length < articlePageSize
    )
      break;
  }
  return rows
    .slice(0, offlineArticleLimit)
    .filter((row) => Number.isSafeInteger(row?.id));
}

async function syncOfflineArticles(
  sync: number,
  generation: number,
  sources: number[],
  signal: AbortSignal,
) {
  const current = () => sync === offlineSyncs && generation === accountChanges;
  let articles: OfflineRow[];
  try {
    articles = await listOfflineRows(sources, signal);
  } catch {
    return;
  }
  if (!current()) return;
  const cache = await caches.open(API_CACHE);
  if (!current()) return;
  await (articles.length > 0
    ? cache.put(OFFLINE_LIST_KEY, Response.json(articles))
    : cache.delete(OFFLINE_LIST_KEY));
  const versions = new Map(
    articles.map((row) => [String(row.id), String(row.revision)]),
  );
  const stored = (await cache.keys())
    .map((request) => new URL(request.url))
    .filter((url) => url.pathname === OFFLINE_ARTICLE_PATH);
  const have = new Set<string>();
  await Promise.all(
    stored.map(async (url) => {
      const id = url.searchParams.get("article") ?? "";
      if (!versions.has(id)) return cache.delete(offlineArticleKey(id));
      const body = await cache.match(offlineArticleKey(id));
      if (versions.get(id) === body?.headers.get(OFFLINE_VERSION)) have.add(id);
      return undefined;
    }),
  );
  const missing = [...versions.keys()].filter((id) => !have.has(id));
  const download = async () => {
    // oxlint-disable-next-line no-await-in-loop -- throttled on purpose
    while (current() && (await anyVisibleClient())) {
      const id = missing.shift();
      if (id === undefined) return;
      // oxlint-disable-next-line no-await-in-loop -- throttled on purpose
      const response = await fetch(`/api/article?article=${id}`, {
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) return;
      const versioned = withHeader(
        response,
        OFFLINE_VERSION,
        versions.get(id) ?? "",
      );
      // oxlint-disable-next-line no-await-in-loop -- throttled on purpose
      if (current()) await cache.put(offlineArticleKey(id), versioned);
    }
  };
  await Promise.allSettled([download(), download()]);
}

worker.addEventListener("message", (event) => {
  if (!isPageMessage(event.data)) return;
  const { sources } = event.data;
  const generation = accountChanges;
  const sync = ++offlineSyncs;
  offlineDownloads.abort();
  offlineDownloads = new AbortController();
  const { signal } = offlineDownloads;
  offlineQueue = offlineQueue
    .then(() => syncOfflineArticles(sync, generation, sources, signal))
    .catch(() => {});
  event.waitUntil(offlineQueue);
});

async function queuedRemovals() {
  const account = await cachedAccount();
  const removals = (await queueAll()).filter(
    ({ value }) =>
      value.account === account &&
      value.method === "DELETE" &&
      new URL(value.url).pathname === "/api/articles",
  );
  return new Set(
    removals.flatMap(({ value }) => {
      const body = uncheckedJson<Removals["/api/articles"]>(value.body);
      return body.removedArticleIdList;
    }),
  );
}

async function offlineArticleList(request: Request) {
  const cache = await caches.open(API_CACHE);
  const stored = await cache.match(OFFLINE_LIST_KEY);
  if (!stored) return undefined;
  const body = uncheckedJson<ArticlesRequest>(await request.text());
  if ((body.filter ?? "unread") !== "unread" || body.query) return undefined;
  const rows = uncheckedJson<OfflineRow[]>(await stored.text());
  let after = (_row: OfflineRow, _index: number) => true;
  const { cursor } = body;
  if (cursor !== undefined) {
    const cursorIndex = rows.findIndex((row) => row.id === cursor);
    if (cursorIndex === -1) {
      const at = Date.parse(request.headers.get(cursorPublishedAtHeader) ?? "");
      if (Number.isNaN(at)) return Response.json([]);
      after = (row) => {
        const published = Date.parse(row.publishedAt);
        return published < at || (published === at && row.id < cursor);
      };
    } else {
      after = (_row, index) => index > cursorIndex;
    }
  }
  let inScope: (row: OfflineRow) => boolean;
  if (body.view === "today") {
    const since = Date.now() - todayWindowHours * 60 * 60_000;
    inScope = (row) => Date.parse(row.publishedAt) >= since;
  } else {
    const storedTree = await cache.match("/api/tree");
    const tree = storedTree
      ? uncheckedJson<Static<typeof treeResponse>>(await storedTree.text())
      : undefined;
    const folder =
      body.folder === undefined
        ? undefined
        : findNode(tree?.tree ?? [], "folder", String(body.folder));
    const sources = new Set(
      folder?.type === "folder" ? sourceIds(folder) : body.sources,
    );
    inScope = (row) => sources.has(row.sourceId);
  }
  const bodies = new Set(
    (await cache.keys())
      .map((key) => new URL(key.url))
      .filter((url) => url.pathname === OFFLINE_ARTICLE_PATH)
      .map((url) => Number(url.searchParams.get("article"))),
  );
  const removed = await queuedRemovals().catch(() => new Set<number>());
  return Response.json(
    rows
      .filter(
        (row, index) =>
          after(row, index) &&
          inScope(row) &&
          bodies.has(row.id) &&
          !removed.has(row.id),
      )
      .map(({ revision: _revision, ...row }) => row),
  );
}

async function articleList(request: Request) {
  try {
    return await fetch(request.clone());
  } catch (error) {
    const offline = await offlineArticleList(request);
    if (offline) return offline;
    throw error;
  }
}

let treePreload: Promise<Response> | undefined;

function treeFaviconUrls(node: TreeNode): string[] {
  if (node.type === "source") return node.favicon ? [node.favicon] : [];
  return node.children.flatMap(treeFaviconUrls);
}

async function pruneFavicons(response: Response) {
  const { tree } = uncheckedJson<Partial<Static<typeof treeResponse>>>(
    await response.text(),
  );
  if (!Array.isArray(tree)) return;
  const named = new Set(tree.flatMap(treeFaviconUrls));
  await deleteWhere(
    await caches.open(API_CACHE),
    (url) =>
      url.pathname.startsWith("/api/favicon/") &&
      !named.has(url.pathname + url.search),
  );
}

async function freshTree(
  event: ExtendableEvent,
  request: Request,
  preload: Promise<Response> | undefined,
) {
  const response = await networkFirst(event, request, preload);
  if (response.ok)
    event.waitUntil(pruneFavicons(response.clone()).catch(() => {}));
  return response;
}

async function cachedTree() {
  const cached = await (await caches.open(API_CACHE)).match("/api/tree");
  return cached ?? new Response(null, { status: 504 });
}

async function completeCachedShell(cache: Cache) {
  const cached = await cache.match("/");
  if (!cached) return undefined;
  const assetUrls = shellAssetUrls(await cached.clone().text());
  const assets = await Promise.all(assetUrls.map((url) => cache.match(url)));
  return assets.every(Boolean) ? { assetUrls, response: cached } : undefined;
}

async function pruneShell(cache: Cache, assetUrls: string[]) {
  const keep = new Set(assetUrls);
  for (const url of assetUrls.filter((asset) => /\.(?:js|css)$/.test(asset))) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of entry files
    const file = await cache.match(url);
    if (!file) return;
    // oxlint-disable-next-line no-await-in-loop -- a handful of entry files
    for (const [named] of (await file.text()).matchAll(/assets\/[\w.-]+/g))
      keep.add(`/${named}`);
  }
  await deleteWhere(
    cache,
    ({ pathname }) => pathname.startsWith("/assets/") && !keep.has(pathname),
  );
}

async function shell(event: ExtendableEvent, path: string) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await completeCachedShell(cache);
  const network = fetch("/", SHELL_REQUEST_INIT);
  const revalidated = network.then(async (response) => {
    if (!response.ok) return;
    if (cached) await pruneShell(cache, cached.assetUrls).catch(() => {});
    const assetUrls = await putShell(cache, response.clone());
    if (cached && assetUrls.join(" ") !== cached.assetUrls.join(" "))
      await notifyClients({ type: "shell-updated" });
  });
  event.waitUntil(revalidated.catch(() => {}));
  if (treePreloadPaths.test(path)) {
    const preload = fetch("/api/tree", { credentials: "same-origin" });
    treePreload = preload;
    event.waitUntil(preload.catch(() => {}));
  }
  if (cached) return cached.response;
  try {
    return await network;
  } catch (error) {
    const partial = await cache.match("/");
    if (partial) return partial;
    throw error;
  }
}

function respond(event: FetchEvent, url: URL): Promise<Response> | undefined {
  const { request } = event;
  if (request.method !== "GET") {
    if (url.pathname === "/api/login") return changeAccount(request, false);
    if (url.pathname === "/api/logout") return changeAccount(request, true);
    if (request.method === "POST" && url.pathname === "/api/articles")
      return articleList(request);
    const removal =
      request.method === "DELETE" ? queueableRemoval(url.pathname) : undefined;
    return removal ? queueableMutation(request, removal) : undefined;
  }
  if (url.pathname.startsWith("/api/favicon/"))
    return cacheFirst(event, request, API_CACHE, { cache: "no-cache" });
  if (url.pathname === "/api/tree") {
    if (url.searchParams.has(cachedTreeQuery)) return cachedTree();
    const preload = treePreload;
    treePreload = undefined;
    return freshTree(event, request, preload);
  }
  if (url.pathname === "/api/options/opml") return undefined;
  if (url.pathname === "/api/events") return undefined;
  if (url.pathname === "/api/article")
    return recentArticleFirst(event, request);
  if (url.pathname.startsWith("/api/")) return networkFirst(event, request);
  if (request.mode === "navigate") return shell(event, url.pathname);
  if (url.pathname.startsWith("/assets/"))
    return cacheFirst(event, request, SHELL_CACHE);
  return undefined;
}

worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin) return;
  const response = respond(event, url);
  if (response) event.respondWith(response);
});
