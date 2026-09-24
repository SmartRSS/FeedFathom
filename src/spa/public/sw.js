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

async function flushQueue() {
  if (!queueMayHaveEntries) return;
  // Cleared before the read, so an entry queued mid-flush sets it again.
  queueMayHaveEntries = false;
  let entries;
  try {
    entries = await queueAll();
  } catch (error) {
    queueMayHaveEntries = true;
    throw error;
  }
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
      } else {
        queueMayHaveEntries = true; // kept for the next flush
      }
    } catch {
      queueMayHaveEntries = true;
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

  // Content-addressed (tree.ts appends a fingerprint of sources.favicon as
  // ?v=): the same icon always lives at the same URL, so a cached copy is
  // never stale and needs no background revalidation.
  if (url.pathname.startsWith("/api/favicon/")) {
    event.respondWith(cacheFirst(request, API_CACHE));
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
