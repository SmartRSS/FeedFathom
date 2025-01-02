// const CACHE_NAME = 'my-cache';
// const urlsToCache = [
// 	'/',
// ];
//
// const MAX_AGE_SECONDS = 60;  // Maximum cache age (1 minute)
//
// self.addEventListener('install', event => {
// 	event.waitUntil(
// 		caches.open(CACHE_NAME)
// 			.then(cache => {
// 				return cache.addAll(urlsToCache);
// 			})
// 	);
// });
//
// self.addEventListener('fetch', event => {
// 	console.log("fetch");
// 	event.respondWith(
// 		caches.open(CACHE_NAME).then(cache => {
// 			return cache.match(event.request).then(response => {
// 				if (response) {
// 					const headers = response.headers.entries();
// 					let date = null;
//
// 					//get timestamp from cache response
// 					for (let pair of headers) {
// 						if (pair[0] === 'date') {
// 							date = new Date(pair[1]);
// 						}
// 					}
//
// 					// if date header found
// 					if (date) {
// 						let age = (new Date().getTime() - date.getTime()) / 1000;
// 						//cache-first if cache is fresh
// 						if (age < MAX_AGE_SECONDS) {
// 							return response;
// 						} else {
// 							return fetchAndCache(event, cache);
// 						}
// 					} else {
// 						//no date header means it's an old SW cache. Use network.
// 						return fetchAndCache(event, cache);
// 					}
// 				} else {
// 					//no cache, so fetch it
// 					return fetchAndCache(event, cache);
// 				}
// 			});
// 		})
// 	);
// });
//
// const fetchAndCache = (event, cache) => {
// 	return fetch(event.request)
// 		.then(networkResponse => {
// 			if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
// 				cache.put(event.request, networkResponse.clone());
// 			}
// 			return networkResponse;
// 		}).catch(() => {
// 			return cache.match(event.request);
// 		});
// }
