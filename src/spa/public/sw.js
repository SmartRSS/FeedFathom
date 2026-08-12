// The served filename is a content hash of this file, computed and injected
// by bin/build-spa.ts -- Cloudflare sits in front of production and can hold
// a cached copy past what Cache-Control alone would suggest, so a changed
// file getting a new URL (rather than relying on cache headers) is what
// actually forces clients onto it. CACHE_VERSION is a separate, unrelated
// knob: bump it only to force-purge every cached entry (a change to the
// caching scheme itself, not just app code) -- everyday content changes
// don't need it touched, since the filename hash already changes for those.
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const response = await fetch("/", SHELL_REQUEST_INIT);
      if (!response.ok) return;
      const html = await response.clone().text();
      await cache.put("/", response);
      const assetUrls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
        (match) => match[1],
      );
      await Promise.all(
        assetUrls.map(async (url) => {
          try {
            const assetResponse = await fetch(url);
            if (assetResponse.ok) await cache.put(url, assetResponse);
          } catch {
            // best-effort precache; runtime cacheFirst() covers this on next visit
          }
        }),
      );
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

// Every call opens then immediately closes its connection once the
// transaction settles, rather than holding it open: an app-side logout
// clears this same database (see options-admin.tsx), and a lingering SW
// connection would block that deletion indefinitely (IndexedDB requires
// every connection closed before a database can actually be deleted).

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
      // A 4xx means the server processed and definitively rejected this
      // request (e.g. the article/source/folder no longer exists, or the
      // folder isn't empty) -- it will never succeed by retrying, so stop
      // queueing it forever and tell the page, since the optimistic
      // response already told the user this action had succeeded. 401 is
      // excluded: a session that expired while offline isn't a rejection
      // of the mutation itself, and the old retry-forever behavior lets
      // it succeed once the user re-authenticates. 5xx is presumed
      // transient and also keeps the old retry-forever behavior.
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 401
      ) {
        // eslint-disable-next-line no-await-in-loop -- replay must preserve order
        await queueDelete(key);
        try {
          // A failure here (matchAll/postMessage) isn't a connectivity
          // problem and must not be mistaken for "still offline" by the
          // outer catch below -- that would wrongly stop processing the
          // rest of the queue over a best-effort notification failing.
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

async function responseToDataUrl(response) {
  const contentType =
    response.headers.get("Content-Type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function warmFavicon(cache, path) {
  if (await cache.match(path)) return;
  try {
    const response = await fetch(path);
    if (response.ok) await cache.put(path, response);
  } catch {
    // best-effort; the page's own <img> will just fetch it normally
  }
}

// A source's favicon can change in place (RefreshFavicon) without its URL
// changing, so a cache hit still needs occasional revalidation -- otherwise
// once a favicon is first inlined below, nothing would ever ask the network
// for it again (an inlined <img src> never fires its own request, which is
// what staleWhileRevalidate normally relies on to trigger a refresh). This
// mirrors that same refresh, just triggered from here instead.
async function revalidateFavicon(cache, path) {
  try {
    const response = await fetch(path);
    if (response.ok) await cache.put(path, response);
  } catch {
    // best-effort; still serving the cached copy this time
  }
}

// Inlines whichever favicons are already cached -- a plain cache.match()
// per URL, no network involved, so this never makes the tree wait. Anything
// not yet cached is left as a plain /api/favicon/:id URL so the response
// returns immediately; the page's existing per-icon skeleton (see
// dashboard.tsx TreeItem) covers those exactly as if this didn't run at
// all. Misses get fetched in the background so next load has them inlined,
// and hits get revalidated in the background so an in-place favicon change
// eventually shows up too.
async function inlineTreeFavicons(event, response, cache) {
  let data;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  const urls = (data.tree ?? []).flatMap(treeFaviconUrls);
  const dataUrlByPath = new Map();
  const hits = [];
  const misses = [];
  await Promise.allSettled(
    urls.map(async (path) => {
      const cached = await cache.match(path);
      if (cached) {
        hits.push(path);
        dataUrlByPath.set(path, await responseToDataUrl(cached));
      } else {
        misses.push(path);
      }
    }),
  );
  if (hits.length || misses.length)
    event.waitUntil(
      Promise.allSettled([
        ...misses.map((path) => warmFavicon(cache, path)),
        ...hits.map((path) => revalidateFavicon(cache, path)),
      ]),
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

// Set by shell() the moment a dashboard-bound navigation comes in, so the
// tree fetch starts before the page's own JS bundle has even loaded --
// treeWithInlineFavicons below then reuses it instead of firing a second
// network round trip once the page actually asks for /api/tree.
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

// Favicons rarely change and aren't hash-named like /assets/, so a cached
// copy is worth serving instantly rather than waiting on a network round
// trip every time (unlike the rest of /api/*, where a stale response is
// actually wrong, not just slow) -- but they're not truly immutable either
// (RefreshFavicon can update one in place), so the cache still gets
// refreshed in the background for next time instead of kept forever.
async function staleWhileRevalidate(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const revalidated = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  // Without waitUntil, the browser can idle the worker the instant this
  // function's response resolves -- killing the background refetch above
  // before it ever reaches the network, silently defeating "next time".
  event.waitUntil(revalidated);
  return cached ?? (await revalidated) ?? Response.error();
}

// Routes that never show the dashboard tree -- mirrors the check the page
// itself used to do before firing its own early tree fetch.
const TREE_PRELOAD_EXCLUDED_PATHS =
  /^\/(admin|login|options|preview|register|activate\/)/;

async function shell(event, path) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch("/", SHELL_REQUEST_INIT);
    if (response.ok) cache.put("/", response.clone());
    if (!TREE_PRELOAD_EXCLUDED_PATHS.test(path)) {
      treePreload = fetch("/api/tree", { credentials: "same-origin" });
      event.waitUntil(treePreload.catch(() => {}));
    }
    return response;
  } catch (error) {
    const cached = await cache.match("/");
    if (cached) return cached;
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
