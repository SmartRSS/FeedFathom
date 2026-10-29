const isLoopbackHostname = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1"
  )
    return true;
  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255) &&
    Number(parts[0]) === 127
  );
};
export const canonicalizeInstance = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopbackHostname(url.hostname))) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.href === `${url.origin}/`
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
};

export const normalizeFeedAddress = (address: string): string => {
  const lowerAddress = address.toLowerCase();
  if (lowerAddress.startsWith("feed://")) {
    return `https://${address.slice(7)}`;
  }

  if (
    lowerAddress.startsWith("feed:http://") ||
    lowerAddress.startsWith("feed:https://")
  ) {
    return address.slice(5);
  }

  return address;
};

export const buildPreviewUrl = (
  instance: string,
  address: string,
): string | undefined => {
  const origin = canonicalizeInstance(instance);
  if (!origin) {
    return undefined;
  }

  const previewUrl = new URL("/preview", origin);
  previewUrl.searchParams.set("feedUrl", normalizeFeedAddress(address));
  return previewUrl.href;
};

// With no configured instance there's nowhere to preview through, so the
// feed address itself is the best we can open.
export const resolveFeedOpenUrl = (
  instance: null | string,
  feedUrl: string,
): string =>
  (instance && buildPreviewUrl(instance, feedUrl)) ??
  normalizeFeedAddress(feedUrl);

// The SPA mints the address itself, at the mail domain the instance
// advertises, so the extension only opens the page that does it.
export const buildNewsletterUrl = (instance: string): string | undefined => {
  const origin = canonicalizeInstance(instance);
  return origin ? new URL("/preview?newsletter", origin).href : undefined;
};
