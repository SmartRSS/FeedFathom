import { Type } from "typebox";
import { Value } from "typebox/value";

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
const instanceOrigin = (value: string): string | undefined => {
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

const instanceUrlSchema = Type.Codec(
  Type.Refine(Type.String(), (value) => instanceOrigin(value) !== undefined),
)
  .Decode((value) => new URL(value).origin)
  .Encode((value) => value);

export const canonicalizeInstance = (value: string): string | undefined =>
  Value.Check(instanceUrlSchema, value)
    ? Value.Decode(instanceUrlSchema, value)
    : undefined;

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

// mailDomain comes from the instance's own config (see /api/session):
// inbound mail is routed wherever Email Routing is configured, which is
// rarely the host the app is served from. The instance hostname is only a
// fallback for the single-domain case.
export const buildNewsletterAddress = (
  instance: string,
  id: string,
  mailDomain?: string,
): string | undefined => {
  const origin = canonicalizeInstance(instance);
  if (!origin) {
    return undefined;
  }

  const host = mailDomain?.trim() ?? "";
  return `${id}@${host === "" ? new URL(origin).hostname : host}`;
};
