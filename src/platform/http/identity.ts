export type HttpClientIdentity = {
  // FEED_FATHOM_DOMAIN. Falls back to "localhost" when unset.
  instance?: string | undefined;
  // FEEDFATHOM_BUILD: the commit baked into the image. Omitted from the
  // User-Agent when unset rather than guessed from the pulled tag.
  version?: string | undefined;
};

const userAgentProduct = "SmartRSS/FeedFathom";
const userAgentUrl = "+https://github.com/SmartRSS/FeedFathom";
const shortShaLength = 7;

// Both fields land in an outgoing header, so anything outside this set is
// dropped rather than escaped. It covers hostnames with an optional :port and
// every tag shape produced here, and excludes the ";" / ")" / CR / LF that
// would let a mis-set env var break the header. Empty is treated as absent.
function sanitizeIdentity(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replaceAll(/[^\w.:-]/gu, "");
  if (cleaned === undefined || cleaned === "") return undefined;
  return cleaned;
}

// FEEDFATHOM_TAG is usually a full commit SHA; 7 characters identify the build
// just as well. Anything shorter (a channel tag, a semver) passes through.
function normalizeVersion(value: string | undefined): string | undefined {
  const tag = sanitizeIdentity(value);
  if (tag === undefined) return undefined;
  return /^[0-9a-f]{40}$/u.test(tag) ? tag.slice(0, shortShaLength) : tag;
}

// Feed readers report their subscriber count in the User-Agent -- often the
// only audience feedback RSS gives a publisher. Google's Feedfetcher set the
// shape ("...; 4 subscribers; feed-id=...") and Feedly, Feedbin and Inoreader
// copied it, so publishers scrape the literal word "subscribers".
//
// The build tag and instance host ride along so two FeedFathom instances can
// be told apart. The "+" slot keeps the project URL, not the instance host: a
// self-hosted domain explains nothing to the publisher reading it.
export function buildUserAgentPrefix(identity: HttpClientIdentity): string {
  const version = normalizeVersion(identity.version);
  const product = version ? `${userAgentProduct}/${version}` : userAgentProduct;
  const instance = sanitizeIdentity(identity.instance) ?? "localhost";
  return `${product} (${userAgentUrl}; instance=${instance}`;
}

// Only appended when a real count is known -- discovery and preview fetches
// have no subscribers, and claiming otherwise poisons the numbers this exists
// to report. Plural even at one, because the regexes match the literal word.
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
