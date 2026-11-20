import { previewPath } from "#shared/contracts/spa-routes.ts";
import { secureOrigin } from "#shared/util/safe-url.ts";

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

export const targetUrl = (
  target: OpenTarget,
  instance: InstanceOrigin | null,
): string | undefined => {
  if (typeof target === "object") {
    const feedUrl = normalizeFeedAddress(target.feedUrl);
    return instance ? `${instance}${previewPath({ feedUrl })}` : feedUrl;
  }
  if (!instance) return undefined;
  if (target === "dashboard") return instance;
  return `${instance}${previewPath({ newsletter: true })}`;
};
