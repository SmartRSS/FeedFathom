import { previewPath } from "#shared/contracts/spa-routes.ts";
import { secureOrigin } from "#shared/util/safe-url.ts";

// An instance address that canonicalizeInstance accepted. Everything that builds a URL on the instance takes
// this type, so the address is checked once, where it enters.
export type InstanceOrigin = string & { readonly brand: "InstanceOrigin" };

const isInstanceOrigin = (value: string): value is InstanceOrigin =>
  secureOrigin(value) === value;

export const canonicalizeInstance = (
  value: string,
): InstanceOrigin | undefined => {
  const origin = secureOrigin(value) ?? "";
  return isInstanceOrigin(origin) ? origin : undefined;
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
