// The worker is served under a content hash of its bundle (bin/build-spa.ts):
// a new URL is what moves clients onto a changed file, since Cloudflare can
// hold a cached copy past what Cache-Control suggests. The server gives the
// worker its own caching headers by the pattern.
export const serviceWorkerFile = (hash: string) => `sw-${hash}.js`;
export const serviceWorkerPathPattern = /^\/sw-[a-f0-9]+\.js$/;
