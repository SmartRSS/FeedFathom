// The served filename is a content hash injected by bin/build-spa.ts: a new
// URL is what forces clients onto a changed file, since Cloudflare can hold a
// cached copy past what Cache-Control suggests. CACHE_VERSION is separate --
// bump it only to force-purge every cached entry when the caching scheme
// itself changes.
const CACHE_VERSION = "v6";
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const API_CACHE = `api-${CACHE_VERSION}`;
const SHELL_REQUEST_INIT = {
  credentials: "same-origin",
  headers: { Accept: "text/html" },
};

// Deletes/removals we know how to fake an optimistic success response for,
// so the UI updates immediately while the real request replays once online.
// ponytail: hand-picked table instead of generic mutation queueing, since
// most /api/* mutations (subscribe, folder create) return server-generated
// data we can't fake offline.
const QUEUEABLE_MUTATIONS = [
  {
    method: "DELETE",
    path: "/api/articles",
    optimisticBody: (body) => body.removedArticleIdList,
  },
  {
    method: "DELETE",
    path: "/api/source",
    optimisticBody: (body) => body.removeSourceId,
  },
  {
    method: "DELETE",
    path: "/api/folders",
    optimisticBody: (body) => body.removeFolderId,
  },
];

function shellAssetUrls(html) {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    (match) => match[1],
  );
}

// Caches the shell's assets before the HTML that names them, so a cached "/"
// never points at files the cache lacks. Returns the asset list.
async function putShell(cache, response) {
  const assetUrls = shellAssetUrls(await response.clone().text());
  await Promise.all(
    assetUrls.map(async (url) => {
      if (await cache.match(url)) return; // hash-named, so never stale
      try {
        const assetResponse = await fetch(url);
        if (assetResponse.ok) await cache.put(url, assetResponse);
      } catch {
        // best-effort precache; runtime cacheFirst() covers this on next visit
      }
    }),
  );
  await cache.put("/", response);
  return assetUrls;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch("/", SHELL_REQUEST_INIT);
      if (response.ok) await putShell(await caches.open(SHELL_CACHE), response);
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== API_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim())
      .then(() => flushQueue()),
  );
});

self.addEventListener("sync", (event) => {
  if (event.tag === "replay-mutations") event.waitUntil(flushQueue());
});

const QUEUE_DB = "mutation-queue";
const QUEUE_STORE = "mutations";

function openQueueDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(QUEUE_STORE, { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Starts true so the worker's first flush looks at whatever an earlier
// instance left queued. flushQueue skips the IndexedDB round trip while it is
// false, which is nearly always: every successful GET would otherwise open the
// database only to find it empty.
let queueMayHaveEntries = true;

// Every call closes its connection once the transaction settles. Logout
// deletes this same database (see options.tsx), and IndexedDB blocks a
// deletion indefinitely while any connection stays open.

async function queueAdd(entry) {
  const db = await openQueueDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).add(entry);
      tx.oncomplete = () => {
        queueMayHaveEntries = true;
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function queueAll() {
  const db = await openQueueDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readonly");
      const cursorRequest = tx.objectStore(QUEUE_STORE).openCursor();
      const entries = [];
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return resolve(entries);
        entries.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  } finally {
    db.close();
  }
}

async function queueDelete(key) {
  const db = await openQueueDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function notifyMutationFailed(value, status) {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({
      method: value.method,
      status,
      type: "queued-mutation-failed",
      url: value.url,
    });
  }
}

// Each queued removal records the account that made it, so a replay under
// another account's session drops it instead of sending it (#982). Even with
// every endpoint scoped by user, two accounts can share a source: account B
// replaying A's removals would unsubscribe B from it or hide its articles.
// The worker learns the account from GET /api/session and records its id in
// the API cache, which holds one account's data and is emptied on sign-in and
// logout. It reads the record offline, at queue time, and refreshes it before
// each replay. The record has a key of its own: the page's own /api/session
// requests are cached too, and a signed-out answer there must not erase the
// owner of removals made before the session expired.
const SESSION_PATH = "/api/session";
const ACCOUNT_KEY = "/sw-queue-account";

async function cachedAccount() {
  try {
    const cached = await (await caches.open(API_CACHE)).match(ACCOUNT_KEY);
    return (await cached?.json())?.id;
  } catch {
    return undefined;
  }
}

// Bumped when a sign-in or logout starts and when it succeeds. A session
// lookup or a replay that began under an earlier count may be answered for
// the previous account, so it neither records that answer nor sends anything
// more.
let accountChanges = 0;

// The latest flush's session lookup and the count it started under.
let pendingLookup;

// Undefined when offline, failing, signed out, or overtaken by an account
// change: the queue then waits, as it does for a 401, so a session that
// expired offline still replays its own removals once the same account signs
// back in.
async function sessionAccount(generation) {
  try {
    const response = await fetch(SESSION_PATH, { credentials: "same-origin" });
    if (!response.ok) return undefined;
    const id = (await response.json())?.user?.id;
    const cache = await caches.open(API_CACHE);
    if (generation !== accountChanges) return undefined;
    if (id !== undefined) await cache.put(ACCOUNT_KEY, Response.json({ id }));
    return id;
  } catch {
    return undefined;
  }
}

async function flushQueue() {
  if (!queueMayHaveEntries) return;
  // Cleared before the read, so an entry queued mid-flush sets it again.
  queueMayHaveEntries = false;
  const generation = accountChanges;
  let entries;
  try {
    entries = await queueAll();
  } catch (error) {
    queueMayHaveEntries = true;
    throw error;
  }
  // With nothing to replay, the session is fetched only to fill a missing
  // record (after a sign-in, or on first run), so offline removals have an
  // account to carry.
  if (entries.length === 0 && (await cachedAccount()) !== undefined) return;
  const lookup = sessionAccount(generation);
  pendingLookup = { generation, lookup };
  const account = await lookup;
  if (account === undefined) {
    // Retried on the next successful request until an account is recorded.
    queueMayHaveEntries = true;
    return;
  }
  for (const { key, value } of entries) {
    if (generation !== accountChanges) {
      queueMayHaveEntries = true;
      break;
    }
    try {
      // An entry with no account was queued before entries carried one; its
      // owner can't be told apart from the current session, so it is
      // dropped too.
      if (value.account !== account) {
        // eslint-disable-next-line no-await-in-loop -- replay must preserve order
        await queueDelete(key);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- replay must preserve order
      const response = await fetch(value.url, {
        body: value.body,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: value.method,
      });
      if (response.ok) {
        // eslint-disable-next-line no-await-in-loop -- replay must preserve order
        await queueDelete(key);
        continue;
      }
      // A 4xx is a definitive rejection that retrying can't fix, so drop it
      // and tell the page -- the optimistic response already claimed success.
      // 401 is excluded (a session that expired offline succeeds once the user
      // re-authenticates) and 5xx is presumed transient; both retry forever,
      // and hold back every later entry, which may depend on this one (#975).
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 401
      ) {
        // eslint-disable-next-line no-await-in-loop -- replay must preserve order
        await queueDelete(key);
        try {
          // matchAll/postMessage failing is not a connectivity problem; the
          // outer catch would read it as "still offline" and stop the queue.
          // eslint-disable-next-line no-await-in-loop -- best-effort notify per entry
          await notifyMutationFailed(value, response.status);
        } catch {
          // Best-effort: the entry is already dequeued either way.
        }
      } else {
        queueMayHaveEntries = true; // kept for the next flush
        break;
      }
    } catch {
      queueMayHaveEntries = true;
      break; // still offline, stop and retry on the next successful request or sync event
    }
  }
}

// Right after a sign-in, or on first run, the record stays empty until the
// first flush's session lookup answers, so a removal made meanwhile waits for
// that answer -- unless the account changed since the lookup started.
async function ownerAccount() {
  const generation = accountChanges;
  const pending = pendingLookup;
  const cached = await cachedAccount();
  if (cached !== undefined) return cached;
  return pending?.generation === generation ? await pending.lookup : undefined;
}

async function queueableMutation(request, route) {
  // Read before the request goes out, so a sign-in in another tab while it is
  // in flight doesn't become the owner of a removal it didn't make.
  const owner = ownerAccount();
  try {
    return await fetch(request.clone());
  } catch (error) {
    const account = await owner;
    // The replay would drop a removal with no owner, so fail it now rather
    // than answer with a success that never lands.
    if (account === undefined) throw error;
    const bodyText = await request.text();
    await queueAdd({
      account,
      body: bodyText,
      method: request.method,
      url: request.url,
    });
    if ("sync" in self.registration) {
      try {
        await self.registration.sync.register("replay-mutations");
      } catch {
        // background sync unsupported/denied; flushQueue() still runs
        // opportunistically on the next successful /api/* request
      }
    }
    return Response.json(route.optimisticBody(JSON.parse(bodyText)));
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// The API cache holds one account's private data and isn't keyed by account,
// so a sign-in empties it before the page sees the response. Logout clears it
// too (options.tsx), but a session that expired or was revoked reaches the
// login form without logging out, and the next sign-in may be another
// account (#974). That also drops the recorded queue account; the next flush
// fetches the new one. Logout passes through here too, so it fences session
// lookups that are still in flight.
async function changeAccount(request) {
  accountChanges++;
  const response = await fetch(request);
  if (response.ok) {
    accountChanges++;
    await caches.delete(API_CACHE);
    queueMayHaveEntries = true;
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
      void flushQueue();
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

function treeFaviconUrls(node) {
  return node.type === "source"
    ? node.favicon
      ? [node.favicon]
      : []
    : (node.children ?? []).flatMap(treeFaviconUrls);
}

function withInlinedFavicon(node, dataUrlByPath) {
  if (node.type === "source") {
    const inlined = node.favicon && dataUrlByPath.get(node.favicon);
    return inlined ? { ...node, favicon: inlined } : node;
  }
  return {
    ...node,
    children: (node.children ?? []).map((child) =>
      withInlinedFavicon(child, dataUrlByPath),
    ),
  };
}

// Articles in the cache carry the time they were fetched, so their age is
// known even after the worker restarts.
const FETCHED_AT = "X-SW-Fetched-At";

function putWithFetchedAt(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set(FETCHED_AT, String(Date.now()));
  return cache.put(
    request,
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

// Keyed by path -- the path is content-addressed (tree.ts appends a
// fingerprint of sources.favicon as ?v=), so the same path always decodes to
// the same bytes and the memo never needs invalidating.
const faviconDataUrls = new Map();

async function faviconDataUrl(path, cached) {
  const memo = faviconDataUrls.get(path);
  if (memo) return memo;
  const contentType =
    cached.headers.get("Content-Type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await cached.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const dataUrl = `data:${contentType};base64,${btoa(binary)}`;
  faviconDataUrls.set(path, dataUrl);
  return dataUrl;
}

// Inlines whichever favicons are already cached -- cache.match() only, no
// network, so the tree never waits. Uncached ones stay plain
// /api/favicon/:id?v=... URLs, covered by the per-icon skeleton in
// dashboard.tsx and cached by the fetch handler's cacheFirst on first load.
async function inlineTreeFavicons(response, cache) {
  let data;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  const urls = (data.tree ?? []).flatMap(treeFaviconUrls);
  const dataUrlByPath = new Map();
  await Promise.allSettled(
    urls.map(async (path) => {
      const cached = await cache.match(path);
      if (cached) dataUrlByPath.set(path, await faviconDataUrl(path, cached));
    }),
  );
  if (dataUrlByPath.size === 0) return null;
  const patched = {
    ...data,
    tree: (data.tree ?? []).map((node) =>
      withInlinedFavicon(node, dataUrlByPath),
    ),
  };
  return new Response(JSON.stringify(patched), {
    headers: { "Content-Type": "application/json" },
  });
}

// The dashboard prefetches the next article in idle time (#716); a copy this
// young is served without a round trip, so opening it is instant online too.
// The body carries no read state, and a feed update landing within the
// window shows up on the next open after it.
const ARTICLE_FRESH_MS = 60 * 1000;
// Nothing else evicts an opened article before CACHE_VERSION changes.
const ARTICLE_CACHE_LIMIT = 200;

// cache.keys() lists entries in insertion order, and a put replaces an
// entry at the end, so the oldest fetches come first.
async function trimArticles(cache) {
  const articles = (await cache.keys()).filter(
    (request) => new URL(request.url).pathname === "/api/article",
  );
  await Promise.all(
    articles
      .slice(0, -ARTICLE_CACHE_LIMIT)
      .map((request) => cache.delete(request)),
  );
}

async function recentArticleFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
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
      putWithFetchedAt(cache, request, response.clone()).then(() =>
        trimArticles(cache),
      );
      void flushQueue();
    }
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

// Unread bodies downloaded for offline reading (#992). Their keys sit apart
// from /api/article, so trimArticles leaves them alone and recentArticleFirst
// serves them without a round trip. They live in the API cache, so a sign-in
// or logout empties them with the rest of the account's data. The page owns
// the setting and the selection: each sync posts the unread rows it wants
// kept, and an empty list when the option is switched off. The rows are kept
// too, as the article list offline (offlineArticleList).
const OFFLINE_ARTICLE_PATH = "/sw-offline-article";
const OFFLINE_LIST_KEY = "/sw-offline-articles";
const offlineArticleKey = (id) => `${OFFLINE_ARTICLE_PATH}?article=${id}`;
// The row's revision when the body was fetched: a feed that rewrites the
// article bumps it, and the next sync fetches the body again.
const OFFLINE_VERSION = "X-SW-Version";

// Bumped per sync, so a newer list -- or the option going off -- stops the
// downloads of an older one.
let offlineSyncs = 0;
// Syncs run one after another, so an older one can't prune what a newer one
// keeps.
let offlineQueue = Promise.resolve();

async function anyVisibleClient() {
  const clients = await self.clients.matchAll({ type: "window" });
  return clients.some((client) => client.visibilityState === "visible");
}

// The page's sync tags its list requests with a token; this records the
// account count when each token's first request passed through, so rows
// listed before a sign-in or logout -- even one in another tab -- are
// dropped rather than written into the next account's cache. It records the
// listing's order too: rows listed before the last applied ones, by another
// tab, are older news and dropped.
const OFFLINE_SYNC_HEADER = "X-Offline-Sync";
const offlineListings = new Map();
let offlineListingOrder = 0;
let offlineApplied = 0;
let offlineDownloads = new AbortController();
// ponytail: a few tabs' syncs at once; the oldest token is forgotten past
// this, and its rows dropped like any unknown token's.
const OFFLINE_LISTINGS_LIMIT = 16;

// `generation` is that count for the posted rows.
async function syncOfflineArticles(sync, generation, articles, signal) {
  const current = () => sync === offlineSyncs && generation === accountChanges;
  const cache = await caches.open(API_CACHE);
  // Checked after the open: one that resolves after a sign-in hands back the
  // next account's cache.
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
  const have = new Set();
  // Read, removed and aged-out articles are simply missing from the list. An
  // outdated body stays readable until its replacement lands.
  await Promise.all(
    stored.map(async (url) => {
      const id = url.searchParams.get("article");
      if (!versions.has(id)) return cache.delete(offlineArticleKey(id));
      const body = await cache.match(offlineArticleKey(id));
      if (versions.get(id) === body?.headers.get(OFFLINE_VERSION)) have.add(id);
    }),
  );
  const missing = [...versions.keys()].filter((id) => !have.has(id));
  // A hidden tab, a failed request or going offline ends the run; the page's
  // next sync picks up whatever is still missing.
  const download = async () => {
    while (current() && (await anyVisibleClient())) {
      const id = missing.shift();
      if (id === undefined) return;
      // eslint-disable-next-line no-await-in-loop -- throttled on purpose
      const response = await fetch(`/api/article?article=${id}`, {
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) return;
      const headers = new Headers(response.headers);
      headers.set(OFFLINE_VERSION, versions.get(id));
      const versioned = new Response(response.body, {
        headers,
        status: response.status,
      });
      // eslint-disable-next-line no-await-in-loop -- throttled on purpose
      if (current()) await cache.put(offlineArticleKey(id), versioned);
    }
  };
  // ponytail: two downloads at a time, so a sync never crowds out the
  // article the reader opens meanwhile; tune if a large backlog drags.
  await Promise.allSettled([download(), download()]);
}

self.addEventListener("message", (event) => {
  const { data } = event;
  if (data?.type !== "offline-articles" || !Array.isArray(data.articles))
    return;
  const articles = data.articles.filter((row) => Number.isSafeInteger(row?.id));
  // Rows count from when the page started listing them, and are rejected
  // before the count moves, so stale rows can't stop the current account's
  // downloads. Switching the option off posts no token: the device-wide
  // setting clears whoever is signed in, and outranks every listing so far.
  const generation = accountChanges;
  let order = offlineListingOrder;
  if (data.token !== undefined) {
    const listing = offlineListings.get(data.token);
    offlineListings.delete(data.token);
    if (listing?.generation !== generation || listing.order < offlineApplied)
      return;
    order = listing.order;
  } else {
    // No listing in flight may undo "off".
    offlineListings.clear();
  }
  offlineApplied = order;
  const sync = ++offlineSyncs;
  // A stalled download would otherwise hold the queue, and a clear behind it.
  offlineDownloads.abort();
  offlineDownloads = new AbortController();
  const { signal } = offlineDownloads;
  offlineQueue = offlineQueue
    .then(() => syncOfflineArticles(sync, generation, articles, signal))
    .catch(() => {});
  event.waitUntil(offlineQueue);
});

function treeSourceIds(node) {
  return node.type === "source"
    ? [Number(node.uid)]
    : (node.children ?? []).flatMap(treeSourceIds);
}

function findFolder(nodes, uid) {
  for (const node of nodes) {
    if (node.type !== "folder") continue;
    if (node.uid === uid) return node;
    const nested = findFolder(node.children ?? [], uid);
    if (nested) return nested;
  }
  return undefined;
}

// Articles this account removed offline, still waiting to replay.
async function queuedRemovals() {
  const account = await cachedAccount();
  const removals = (await queueAll()).filter(
    ({ value }) =>
      value.account === account &&
      value.method === "DELETE" &&
      new URL(value.url).pathname === "/api/articles",
  );
  return new Set(
    removals.flatMap(({ value }) => JSON.parse(value.body).removedArticleIdList),
  );
}

// The unread list offline, answered from the rows the last sync kept, scoped
// the way the server scopes it, and only those whose body is stored and that
// weren't removed offline since. Undefined, and so a network error, for what
// those rows can't answer: other filters, and search.
async function offlineArticleList(request) {
  const cache = await caches.open(API_CACHE);
  const stored = await cache.match(OFFLINE_LIST_KEY);
  if (!stored) return undefined;
  const body = await request.json();
  if ((body.filter ?? "unread") !== "unread" || body.query) return undefined;
  // A page continues with the rows after its cursor in the server's order,
  // newest first -- whether the page before came from here or the network.
  // The page sends the cursor's publishedAt, which places it even once it
  // has left the kept rows, read or removed since.
  const rows = await stored.json();
  let after = () => true;
  if (body.cursor !== undefined) {
    const at = Date.parse(
      rows.find((row) => row.id === body.cursor)?.publishedAt ??
        request.headers.get("X-Cursor-Published-At"),
    );
    if (Number.isNaN(at)) return Response.json([]);
    after = (row) => {
      const published = Date.parse(row.publishedAt);
      return published < at || (published === at && row.id < body.cursor);
    };
  }
  let inScope;
  if (body.view === "today") {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    inScope = (row) => Date.parse(row.publishedAt) >= since;
  } else {
    const tree = await (await cache.match("/api/tree"))?.json();
    const folder =
      body.folder === undefined
        ? undefined
        : findFolder(tree?.tree ?? [], String(body.folder));
    const sources = new Set(folder ? treeSourceIds(folder) : body.sources);
    inScope = (row) => sources.has(row.sourceId);
  }
  const bodies = new Set(
    (await cache.keys())
      .map((key) => new URL(key.url))
      .filter((url) => url.pathname === OFFLINE_ARTICLE_PATH)
      .map((url) => Number(url.searchParams.get("article"))),
  );
  const removed = await queuedRemovals().catch(() => new Set());
  return Response.json(
    rows
      .filter(
        (row) =>
          after(row) &&
          inScope(row) &&
          bodies.has(row.id) &&
          !removed.has(row.id),
      )
      // The list never asks for revisions (see articlesRequest).
      .map(({ revision: _revision, ...row }) => row),
  );
}

async function articleList(request) {
  const token = request.headers.get(OFFLINE_SYNC_HEADER);
  if (token && !offlineListings.has(token)) {
    offlineListings.set(token, {
      generation: accountChanges,
      order: ++offlineListingOrder,
    });
    if (offlineListings.size > OFFLINE_LISTINGS_LIMIT)
      offlineListings.delete(offlineListings.keys().next().value);
  }
  try {
    return await fetch(request.clone());
  } catch (error) {
    // A sync answered from its own kept rows would only shrink them.
    if (token) throw error;
    const offline = await offlineArticleList(request);
    if (offline) return offline;
    throw error;
  }
}

// Set by shell() on a dashboard-bound navigation, so the tree fetch starts
// before the page's JS bundle loads; treeWithInlineFavicons reuses it instead
// of firing a second round trip.
let treePreload;

async function treeWithInlineFavicons(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const preload = treePreload;
  treePreload = undefined;
  try {
    const response = await (preload ?? fetch(request));
    if (response.ok) {
      cache.put(request, response.clone());
      void flushQueue();
      const patched = await inlineTreeFavicons(response.clone(), cache);
      if (patched) return patched;
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

// Boot paints from this while its real /api/tree request is in flight
// (#989), so a cached tree shows at once on a slow connection. It never goes
// to the network -- the real request already has -- so a miss is a bare 504
// the page reads as "nothing cached". The cache holds the current account's
// data only (see changeAccount).
async function cachedTree(cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match("/api/tree");
  if (!cached) return new Response(null, { status: 504 });
  return (await inlineTreeFavicons(cached.clone(), cache)) ?? cached;
}

// Routes that never show the dashboard tree.
const TREE_PRELOAD_EXCLUDED_PATHS =
  /^\/(admin|login|options|password-reset|preview|register|activate\/)/;

// The cached "/" is served only while every asset it names is cached too: a
// past deploy's assets are gone from the server, so a partial copy would load
// a blank page. Without a complete copy the navigation waits for the network.
async function completeCachedShell(cache) {
  const cached = await cache.match("/");
  if (!cached) return undefined;
  const assetUrls = shellAssetUrls(await cached.clone().text());
  const assets = await Promise.all(assetUrls.map((url) => cache.match(url)));
  return assets.every(Boolean) ? { assetUrls, response: cached } : undefined;
}

async function notifyShellUpdated() {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) client.postMessage({ type: "shell-updated" });
}

// Cache first, so a warm launch on a weak connection paints at once; the
// network copy replaces the cache for the next launch. The worker's URL
// hashes only sw.js, so a deploy that changes just the bundle never fires
// controllerchange -- a changed asset list is what tells open pages instead.
async function shell(event, path) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await completeCachedShell(cache);
  const network = fetch("/", SHELL_REQUEST_INIT);
  const revalidated = network.then(async (response) => {
    if (!response.ok) return;
    const assetUrls = await putShell(cache, response.clone());
    if (cached && assetUrls.join() !== cached.assetUrls.join())
      await notifyShellUpdated();
  });
  event.waitUntil(revalidated.catch(() => {}));
  if (!TREE_PRELOAD_EXCLUDED_PATHS.test(path)) {
    treePreload = fetch("/api/tree", { credentials: "same-origin" });
    event.waitUntil(treePreload.catch(() => {}));
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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method !== "GET") {
    if (url.pathname === "/api/login" || url.pathname === "/api/logout") {
      event.respondWith(changeAccount(request));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/articles") {
      event.respondWith(articleList(request));
      return;
    }
    const route = QUEUEABLE_MUTATIONS.find(
      (candidate) =>
        candidate.method === request.method && url.pathname === candidate.path,
    );
    if (route) event.respondWith(queueableMutation(request, route));
    return;
  }

  // Content-addressed (tree.ts appends a fingerprint of sources.favicon as
  // ?v=): the same icon always lives at the same URL, so a cached copy is
  // never stale and needs no background revalidation.
  if (url.pathname.startsWith("/api/favicon/")) {
    event.respondWith(cacheFirst(request, API_CACHE));
    return;
  }
  if (url.pathname === "/api/tree") {
    event.respondWith(
      url.searchParams.has("cached")
        ? cachedTree(API_CACHE)
        : treeWithInlineFavicons(event, request, API_CACHE),
    );
    return;
  }
  // A file download rather than application state. networkFirst would put the
  // user's whole subscription list in the Cache API and, on an offline click,
  // hand back a copy from whenever it was last exported without saying so.
  if (url.pathname === "/api/options/opml") return;
  // An endless event stream: networkFirst would tee it into a Cache API write
  // that never completes, and an offline fallback would replay old signals.
  if (url.pathname === "/api/events") return;
  if (url.pathname === "/api/article") {
    event.respondWith(recentArticleFirst(request, API_CACHE));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(shell(event, url.pathname));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
