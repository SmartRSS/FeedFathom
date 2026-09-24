// Omits the URL entirely rather than pointing at a favicon that 404s -- the
// SPA and service worker (faviconUrls / treeFaviconUrls) already treat a
// null favicon as "show the fallback icon" instead of re-requesting it.
export function faviconPath(source: {
  hasFavicon: boolean;
  id: number | null;
}): string | null {
  return source.hasFavicon ? `/api/favicon/${source.id}` : null;
}
