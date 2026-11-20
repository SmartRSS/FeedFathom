export type HttpClientIdentity = {
  instance?: string | undefined;
  version?: string | undefined;
};

const userAgentProduct = "SmartRSS/FeedFathom";
const userAgentUrl = "+https://github.com/SmartRSS/FeedFathom";
const shortShaLength = 7;

function sanitizeIdentity(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replaceAll(/[^\w.:-]/gu, "");
  if (cleaned === undefined || cleaned === "") return undefined;
  return cleaned;
}

function normalizeVersion(value: string | undefined): string | undefined {
  const tag = sanitizeIdentity(value);
  if (tag === undefined) return undefined;
  return /^[0-9a-f]{40}$/u.test(tag) ? tag.slice(0, shortShaLength) : tag;
}

export function buildUserAgentPrefix(identity: HttpClientIdentity): string {
  const version = normalizeVersion(identity.version);
  const product = version ? `${userAgentProduct}/${version}` : userAgentProduct;
  const instance = sanitizeIdentity(identity.instance) ?? "localhost";
  return `${product} (${userAgentUrl}; instance=${instance}`;
}

export function buildUserAgent(
  prefix: string,
  subscribers: number | undefined,
): string {
  if (
    subscribers === undefined ||
    !Number.isInteger(subscribers) ||
    subscribers < 0
  ) {
    return `${prefix})`;
  }
  return `${prefix}; ${subscribers} subscribers)`;
}
