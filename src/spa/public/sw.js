// The served filename is a content hash injected by bin/build-spa.ts: a new
// URL is what forces clients onto a changed file, since Cloudflare can hold a
// cached copy past what Cache-Control suggests. CACHE_VERSION is separate --
// bump it only to force-purge every cached entry when the caching scheme
// itself changes.
const CACHE_VERSION = "v5";
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

// Every call closes its connection once the transaction settles. Logout
// deletes this same database (see options.tsx), and IndexedDB blocks a
// deletion indefinitely while any connection stays open.

async function queueAdd(entry) {
  const db = await openQueueDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).add(entry);
      tx.oncomplete = resolve;
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

async function flushQueue() {
  const entries = await queueAll();
  for (const { key, value } of entries) {
    try {
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
      // re-authenticates) and 5xx is presumed transient; both retry forever.
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
      }
    } catch {
      break; // still offline, stop and retry on the next successful request or sync event
    }
  }
}

async function queueableMutation(request, route) {
  try {
    return await fetch(request.clone());
  } catch {
    const bodyText = await request.text();
    await queueAdd({ body: bodyText, method: request.method, url: request.url });
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

// Favicons in the cache carry the time they were fetched, so the tree can
// tell a fresh copy from one due a revalidation even after the worker restarts.
const FAVICON_FETCHED_AT = "X-SW-Fetched-At";
const FAVICON_REVALIDATE_MS = 60 * 60 * 1000;

function putFavicon(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set(FAVICON_FETCHED_AT, String(Date.now()));
  return cache.put(
    request,
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

// Keyed by path; an entry is reused only while its fetch stamp still matches
// the cached copy, so a revalidated icon gets encoded again.
const faviconDataUrls = new Map();

async function faviconDataUrl(path, cached) {
  const fetchedAt = cached.headers.get(FAVICON_FETCHED_AT);
  const memo = faviconDataUrls.get(path);
  if (memo && fetchedAt && memo.fetchedAt === fetchedAt) return memo.dataUrl;
  const contentType =
    cached.headers.get("Content-Type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await cached.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const dataUrl = `data:${contentType};base64,${btoa(binary)}`;
  faviconDataUrls.set(path, { fetchedAt, dataUrl });
  return dataUrl;
}

// A miss needs fetching so the next load can inline it; a hit needs
// revalidating now and then because RefreshFavicon can change one in place
// without changing its URL, and an inlined <img src> never fires a request of
// its own. Revalidating on every tree load would cost one request per source
// on each poll and mark-read.
function faviconIsStale(cached) {
  const fetchedAt = Number(cached?.headers.get(FAVICON_FETCHED_AT));
  return !(Date.now() - fetchedAt < FAVICON_REVALIDATE_MS);
}

async function refreshFavicon(cache, path) {
  try {
    const response = await fetch(path);
    if (response.ok) await putFavicon(cache, path, response);
  } catch {
    // best-effort; the page's own <img> will just fetch it normally
  }
}

// Inlines whichever favicons are already cached -- cache.match() only, no
// network, so the tree never waits. Uncached ones stay plain
// /api/favicon/:id URLs, covered by the per-icon skeleton in dashboard.tsx.
// Misses and stale hits are refreshed in the background for next load.
async function inlineTreeFavicons(event, response, cache) {
  let data;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  const urls = (data.tree ?? []).flatMap(treeFaviconUrls);
  const dataUrlByPath = new Map();
  const stalePaths = [];
  await Promise.allSettled(
    urls.map(async (path) => {
      const cached = await cache.match(path);
      if (faviconIsStale(cached)) stalePaths.push(path);
      if (cached) dataUrlByPath.set(path, await faviconDataUrl(path, cached));
    }),
  );
  if (stalePaths.length)
    event.waitUntil(
      Promise.allSettled(stalePaths.map((path) => refreshFavicon(cache, path))),
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
      const patched = await inlineTreeFavicons(event, response.clone(), cache);
      if (patched) return patched;
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

// Favicons rarely change and aren't hash-named, so a cached copy is worth
// serving instantly -- unlike the rest of /api/*, where stale is wrong rather
// than just slow. RefreshFavicon can still update one in place, so the cache
// is refreshed in the background rather than kept forever.
async function staleWhileRevalidate(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const revalidated = fetch(request)
    .then((response) => {
      if (response.ok) putFavicon(cache, request, response.clone());
      return response;
    })
    .catch(() => undefined);
  // Without waitUntil the browser can idle the worker as soon as the response
  // resolves, killing the background refetch before it reaches the network.
  event.waitUntil(revalidated);
  return cached ?? (await revalidated) ?? Response.error();
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
    const route = QUEUEABLE_MUTATIONS.find(
      (candidate) =>
        candidate.method === request.method && url.pathname === candidate.path,
    );
    if (route) event.respondWith(queueableMutation(request, route));
    return;
  }

  if (url.pathname.startsWith("/api/favicon/")) {
    event.respondWith(staleWhileRevalidate(event, request, API_CACHE));
    return;
  }
  if (url.pathname === "/api/tree") {
    event.respondWith(treeWithInlineFavicons(event, request, API_CACHE));
    return;
  }
  // A file download rather than application state. networkFirst would put the
  // user's whole subscription list in the Cache API and, on an offline click,
  // hand back a copy from whenever it was last exported without saying so.
  if (url.pathname === "/api/options/opml") return;
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
