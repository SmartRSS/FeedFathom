// File name, CACHE_VERSION, and the register() call in main.tsx must all bump
// together on changes: renaming makes any CDN-cached copy of the old file
// irrelevant instead of relying on cache headers alone.
const CACHE_VERSION = "v4";
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

async function queueAdd(entry) {
  const db = await openQueueDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).add(entry);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function queueAll() {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
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
}

async function queueDelete(key) {
  const db = await openQueueDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
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
      // eslint-disable-next-line no-await-in-loop -- replay must preserve order
      if (response.ok) await queueDelete(key);
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

async function shell() {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch("/", SHELL_REQUEST_INIT);
    if (response.ok) cache.put("/", response.clone());
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

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(shell());
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
