import { createHash } from "node:crypto";

const faviconCacheKey = "feedfathom_favicons";
const faviconCacheDuration = 7 * 24 * 60 * 60 * 1000; // 7 days
const hashLength = 8; // Short hash for cache validation

interface FaviconCache {
  [key: string]: {
    hash: string;
    data: string;
    timestamp: number;
  };
}

function getFaviconHash(favicon: string): string {
  // Use first 8 chars of MD5 for shorter transfer
  return createHash("md5").update(favicon).digest("hex").slice(0, hashLength);
}

export function getCachedFavicons(): FaviconCache {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const cached = localStorage.getItem(faviconCacheKey);
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
    localStorage.setItem(faviconCacheKey, JSON.stringify(valid));
    return valid;
  } catch {
    return {};
  }
}

export function cacheFavicon(sourceId: string, favicon: string | null): void {
  if (!favicon || typeof window === "undefined") {
    return;
  }

  try {
    const cache = getCachedFavicons();
    const hash = getFaviconHash(favicon);

    cache[sourceId] = {
      hash,
      data: favicon,
      timestamp: Date.now(),
    };

    localStorage.setItem(faviconCacheKey, JSON.stringify(cache));
  } catch {
    // Ignore storage errors
  }
}

export function getCachedFavicon(
  sourceId: string,
): { hash: string; data: string } | null {
  const cache = getCachedFavicons();
  const entry = cache[sourceId];
  if (!entry) {
    return null;
  }
  return { hash: entry.hash, data: entry.data };
}
