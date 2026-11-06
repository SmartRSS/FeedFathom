import { isLoopbackHostname } from "#shared/net/private-network-guard.ts";
import { previewPath } from "#shared/contracts/preview-route.ts";
import { httpUrlWithoutCredentials } from "#shared/util/safe-url.ts";

// An instance address that canonicalizeInstance accepted: an http(s) origin
// with nothing after it. Everything that builds a URL on the instance takes
// this type, so the address is checked once, where it enters.
export type InstanceOrigin = string & { readonly brand: "InstanceOrigin" };

// Plain http is accepted only for a loopback development instance.
const isInstanceOrigin = (value: string): value is InstanceOrigin => {
  const url = httpUrlWithoutCredentials(value);
  if (!url || url.origin !== value) return false;
  return url.protocol === "https:" || isLoopbackHostname(url.hostname);
};

export const canonicalizeInstance = (
  value: string,
): InstanceOrigin | undefined => {
  const url = URL.parse(value);
  if (!url || url.href !== `${url.origin}/`) return undefined;
  return isInstanceOrigin(url.origin) ? url.origin : undefined;
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

export type OpenTarget = "dashboard" | "newsletter" | { feedUrl: string };

// Undefined when the target needs an instance and none is configured.
export const targetUrl = (
  target: OpenTarget,
  instance: InstanceOrigin | null,
): string | undefined => {
  if (typeof target === "object") {
    const feedUrl = normalizeFeedAddress(target.feedUrl);
    // With no configured instance there's nowhere to preview through, so the
    // feed address itself is the best we can open.
    return instance ? `${instance}${previewPath({ feedUrl })}` : feedUrl;
  }
  if (!instance) return undefined;
  if (target === "dashboard") return instance;
  // The SPA mints the address itself, at the mail domain the instance
  // advertises, so the extension only opens the page that does it.
  return `${instance}${previewPath({ newsletter: true })}`;
};
