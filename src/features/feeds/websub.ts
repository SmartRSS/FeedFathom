import { createHmac, timingSafeEqual } from "node:crypto";
import { parseHttpUrl } from "#platform/http/http-native-transport.ts";

const supportedSignatureAlgorithms = new Set([
  "sha1",
  "sha256",
  "sha384",
  "sha512",
]);

export type WebSubDiscovery = { hubUrl: string; topicUrl: string };

function parseLinkHeaderRels(value: string): Map<string, string> {
  const rels = new Map<string, string>();
  // RFC 8288: `<url>; rel="hub", <url2>; rel="self"`
  for (const part of value.split(",")) {
    const urlMatch = /<([^>]+)>/.exec(part);
    const relMatch = /rel=["']?([^"';]+)["']?/i.exec(part);
    if (!urlMatch || !relMatch) continue;
    const rel = relMatch[1]!.toLowerCase();
    if (!rels.has(rel)) rels.set(rel, urlMatch[1]!);
  }
  return rels;
}

// Plain RSS commonly advertises a hub via an `atom:` namespaced link, and
// HTMLRewriter is a tag-soup scanner, so it sees a literal "atom:link" tag
// name and both forms need a selector. Same pattern as scanner-page.ts.
function scanFeedBodyRels(xml: string): Map<string, string> {
  const rels = new Map<string, string>();
  new HTMLRewriter()
    .on("link[rel], atom\\:link[rel]", {
      element(element) {
        const rel = element.getAttribute("rel")?.toLowerCase();
        const href = element.getAttribute("href");
        if (rel && href && !rels.has(rel)) rels.set(rel, href);
      },
    })
    .transform(xml);
  return rels;
}

// Both the hub and topic URLs come from the feed's own content or headers, so
// they are attacker-influenced and get the same URL policy as every outbound
// request. Resolved against the feed's URL.
function resolvePublicUrl(value: string, base?: string): string | undefined {
  try {
    return parseHttpUrl(new URL(value, base).href).href;
  } catch {
    return undefined;
  }
}

/**
 * Headers take precedence per spec, though most feeds advertise only in the
 * body. Checking both costs nothing; the response was already fetched. A JSON
 * Feed names its hub in a `hubs` array instead, which parseJsonFeed reads.
 */
export function discoverWebSub(
  headers: Headers,
  bodyXml: string,
  feedUrl: string,
  jsonFeedHubUrl?: string,
): WebSubDiscovery | undefined {
  const headerRels = parseLinkHeaderRels(headers.get("link") ?? "");
  const bodyRels = scanFeedBodyRels(bodyXml);

  const hubUrl = headerRels.get("hub") ?? bodyRels.get("hub") ?? jsonFeedHubUrl;
  if (!hubUrl) return undefined;
  const topicUrl = headerRels.get("self") ?? bodyRels.get("self") ?? feedUrl;

  const resolvedHub = resolvePublicUrl(hubUrl, feedUrl);
  const resolvedTopic = resolvePublicUrl(topicUrl, feedUrl);
  if (!resolvedHub || !resolvedTopic) return undefined;

  return { hubUrl: resolvedHub, topicUrl: resolvedTopic };
}

export type HubSubscriptionResult = { ok: true } | { error: string; ok: false };

// Narrow on purpose: HttpClient satisfies it, and a test does not have to
// build one. What matters is that the hub POST goes through the same
// reservation, block check and Retry-After handling as every other outbound
// request, instead of a second path with none of them.
export type HubPoster = {
  post(url: string, body: URLSearchParams): Promise<{ status: number }>;
};

/**
 * A 2xx means only that the hub accepted the request. The hub still has to GET
 * the callback with a challenge (see the callback route), so this never marks
 * a source verified.
 */
export async function requestHubSubscription(params: {
  callbackToken: string;
  // The public host the hub calls back on.
  domain: string;
  hubPoster: HubPoster;
  hubUrl: string;
  secret: string;
  topicUrl: string;
}): Promise<HubSubscriptionResult> {
  const hub = resolvePublicUrl(params.hubUrl);
  if (!hub)
    return { error: "Hub URL is not a public http or https URL", ok: false };

  const body = new URLSearchParams({
    "hub.callback": `https://${params.domain}/api/websub/callback/${params.callbackToken}`,
    "hub.mode": "subscribe",
    "hub.secret": params.secret,
    "hub.topic": params.topicUrl,
    // Deprecated since spec 0.4, but some hubs (WordPress.com's pushpress)
    // still reject the request with "hub.verify is empty" without it.
    "hub.verify": "async",
  });

  try {
    // post() does not follow redirects: the target is fully hub-controlled,
    // so following it is an SSRF surface, and a redirecting hub is unusual
    // enough to just fail.
    const response = await params.hubPoster.post(hub, body);
    return response.status >= 200 && response.status < 300
      ? { ok: true }
      : { error: `Hub responded with ${response.status}`, ok: false };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

/**
 * Checks `X-Hub-Signature` (or `X-Hub-Signature-256`) against the secret given
 * to the hub at subscribe time. The comparison is constant-time: this is all
 * that stands between the real hub and anyone who finds the callback URL.
 */
export function verifyHubSignature(
  secret: string,
  signatureHeader: string | null,
  body: Buffer,
): boolean {
  if (!signatureHeader) return false;
  const [algorithm, hex] = signatureHeader.split("=", 2);
  if (
    !algorithm ||
    !hex ||
    !supportedSignatureAlgorithms.has(algorithm.toLowerCase())
  )
    return false;

  const expected = createHmac(algorithm.toLowerCase(), secret)
    .update(body)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(hex, "hex");
  if (
    expectedBuffer.length === 0 ||
    expectedBuffer.length !== providedBuffer.length
  )
    return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
