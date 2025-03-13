/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';

// Use a constant cache name
const CACHE = "feedfathom-cache-v1";

const ASSETS = [
  ...build, // the app itself
  ...files, // everything in `static`
];

// Store the current version
const CURRENT_VERSION = version;

async function addFilesToCache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(ASSETS);
}

async function deleteOldCache() {
  const cache = await caches.open(CACHE);
  const newAssetPaths = new Set(ASSETS);
  const existingKeys = (await cache.keys()).map(request => new URL(request.url).pathname);

  for (const oldPath of existingKeys) {
    if (!newAssetPaths.has(oldPath)) {
      const oldRequest = new Request(oldPath);
      void cache.delete(oldRequest);
    }
  }
}

// Check for updates and notify clients
async function checkForUpdates() {
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({
      type: "VERSION_CHECK",
      version: CURRENT_VERSION,
    });
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(addFilesToCache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    deleteOldCache(),
    checkForUpdates(),
  ]));
});

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  // ignore POST requests etc
  if (event.request.method !== 'GET') return;

  async function respond() {
    const url = new URL(event.request.url);
    const cache = await caches.open(CACHE);

    // `build`/`files` can always be served from the cache
    if (ASSETS.includes(url.pathname)) {
      const response = await cache.match(url.pathname);

      if (response) {
        return response;
      }
    }

    // for everything else, try the network first, but
    // fall back to the cache if we're offline
    try {
      const response = await fetch(event.request);

      // if we're offline, fetch can return a value that is not a Response
      // instead of throwing - and we can't pass this non-Response to respondWith
      if (!(response instanceof Response)) {
        throw new Error('invalid response from fetch');
      }

      if (response.status === 200) {
        cache.put(event.request, response.clone());
      }

      return response;
    } catch (err) {
      const response = await cache.match(event.request);

      if (response) {
        return response;
      }

      // if there's no cache, then just error out
      // as there is nothing we can do to respond to this request
      throw err;
    }
  }

  event.respondWith(respond());
});
