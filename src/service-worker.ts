const FAVICON_CACHE = "feedfathom-favicons-v1";
const FAVICON_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(FAVICON_CACHE).then((cache) => {
      return cache.addAll([]);
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith("feedfathom-favicons-"))
          .filter((name) => name !== FAVICON_CACHE)
          .map((name) => caches.delete(name)),
      );
    }),
  );
});

self.addEventListener("fetch", (event) => {
  if (!event.request.url.includes("/favicons/")) {
    return;
  }

  event.respondWith(
    (async () => {
      const url = new URL(event.request.url);
      const sourceId = url.pathname.split("/").pop();

      if (!sourceId) {
        return fetch(event.request);
      }

      // Try to get from cache first
      const cache = await caches.open(FAVICON_CACHE);
      const cachedResponse = await cache.match(event.request);

      if (cachedResponse) {
        const cachedData = await cachedResponse.json();
        const now = Date.now();

        // Check if the favicon has changed
        if (now - cachedData.timestamp < FAVICON_CACHE_DURATION) {
          return cachedResponse;
        }
      }

      // If not in cache or needs update, fetch from network
      const response = await fetch(event.request);
      const data = await response.json();

      if (data.changed && data.data) {
        // Update cache with new data
        const newResponse = new Response(
          JSON.stringify({
            ...data,
            timestamp: Date.now(),
          }),
          {
            headers: response.headers,
          },
        );

        await cache.put(event.request, newResponse);
        return newResponse;
      }

      return response;
    })(),
  );
});
