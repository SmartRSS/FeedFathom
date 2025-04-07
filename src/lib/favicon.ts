const faviconCacheKey = "feedfathom_favicons";
const faviconCacheDuration = 7 * 24 * 60 * 60 * 1000; // 7 days
const hashLength = 8; // Short hash for cache validation

interface FaviconEntry {
  readonly hash: string;
  readonly data: string;
  readonly timestamp: number;
}

interface FaviconCache {
  [key: string]: FaviconEntry;
}

function getFaviconHash(favicon: string): string {
  // Use first 8 chars of SHA-256 for shorter transfer
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(favicon);
  return hasher.digest("hex").slice(0, hashLength);
}

export async function getCachedFavicons(): Promise<FaviconCache> {
  if (typeof Bun === "undefined") {
    throw new Error("This function can only be used in a Bun environment");
  }

  try {
    const file = Bun.file(faviconCacheKey);
    const exists = await file.exists();
    if (!exists) {
      return {};
    }

    const cached = await file.text();
    if (!cached) {
      return {};
    }

    const parsed = JSON.parse(cached) as FaviconCache;
    const now = Date.now();

    // Clean up expired entries
    const valid = Object.entries(parsed).reduce((acc, [key, value]) => {
      if (now - value.timestamp < faviconCacheDuration) {
        acc[key] = value;
      }
      return acc;
    }, {} as FaviconCache);

    // Update cache with cleaned data
    await Bun.write(faviconCacheKey, JSON.stringify(valid));
    return valid;
  } catch {
    return {};
  }
}

export async function cacheFavicon(
  sourceId: string,
  favicon: string | null,
): Promise<void> {
  if (!favicon || typeof Bun === "undefined") {
    return;
  }

  try {
    const cache = await getCachedFavicons();
    const hash = getFaviconHash(favicon);

    cache[sourceId] = {
      hash,
      data: favicon,
      timestamp: Date.now(),
    };

    await Bun.write(faviconCacheKey, JSON.stringify(cache));
  } catch {
    // Ignore storage errors
  }
}

export async function getCachedFavicon(
  sourceId: string,
): Promise<{ readonly hash: string; readonly data: string } | null> {
  const cache = await getCachedFavicons();
  const entry = cache[sourceId];
  if (!entry) {
    return null;
  }
  return { hash: entry.hash, data: entry.data };
}
