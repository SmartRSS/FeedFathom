import { createHmac, timingSafeEqual } from "node:crypto";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { isBlockedHostname } from "#shared/net/private-network-guard.ts";

const supportedSignatureAlgorithms = new Set([
  "sha1",
  "sha256",
  "sha384",
  "sha512",
]);

const jsonFeedHubsProjection = Type.Object(
  {
    hubs: Type.Optional(
      Type.Array(
        Type.Object(
          { type: Type.String(), url: Type.String() },
          { additionalProperties: true },
        ),
      ),
    ),
  },
  { additionalProperties: true },
);
const jsonFeedHubsProjectionCheck = Schema.Compile(jsonFeedHubsProjection);

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

// JSON Feed advertises hubs in a `hubs` array in the body instead of a Link
// header or <link rel="hub">. A `hubs[].type` of "WebSub" means the same
// thing; only the place to look differs.
function jsonFeedHubUrl(text: string): string | undefined {
  if (!text.trimStart().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!jsonFeedHubsProjectionCheck.Check(parsed)) return undefined;
    return parsed.hubs?.find((hub) => hub.type === "WebSub")?.url;
  } catch {
    return undefined;
  }
}

// Both the hub and topic URLs come from the feed's own content or headers, so
// they are attacker-influenced and need the same private-network guard as the
// extension's arbitrary-URL reader fetch. Resolved against the feed's URL.
function resolvePublicUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (isBlockedHostname(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Headers take precedence per spec, though most feeds advertise only in the
 * body. Checking both costs nothing; the response was already fetched.
 */
export function discoverWebSub(
  headers: Headers,
  bodyXml: string,
  feedUrl: string,
): WebSubDiscovery | undefined {
  const headerRels = parseLinkHeaderRels(headers.get("link") ?? "");
  const bodyRels = scanFeedBodyRels(bodyXml);

  const hubUrl =
    headerRels.get("hub") ?? bodyRels.get("hub") ?? jsonFeedHubUrl(bodyXml);
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
  callbackUrl: string;
  hubPoster: HubPoster;
  hubUrl: string;
  leaseSeconds?: number;
  mode: "subscribe" | "unsubscribe";
  secret: string;
  topicUrl: string;
}): Promise<HubSubscriptionResult> {
  let hub: URL;
  try {
    hub = new URL(params.hubUrl);
  } catch {
    return { error: "Invalid hub URL", ok: false };
  }
  if (hub.protocol !== "http:" && hub.protocol !== "https:")
    return { error: "Hub URL must be http or https", ok: false };
  if (isBlockedHostname(hub.hostname))
    return { error: "Hub URL resolves to a private address", ok: false };

  const body = new URLSearchParams({
    "hub.callback": params.callbackUrl,
    "hub.mode": params.mode,
    "hub.secret": params.secret,
    "hub.topic": params.topicUrl,
    // Deprecated since spec 0.4, but some hubs (WordPress.com's pushpress)
    // still reject the request with "hub.verify is empty" without it.
    "hub.verify": "async",
    ...(params.leaseSeconds
      ? { "hub.lease_seconds": String(params.leaseSeconds) }
      : {}),
  });

  try {
    // post() does not follow redirects: the target is fully hub-controlled,
    // so following it is an SSRF surface, and a redirecting hub is unusual
    // enough to just fail.
    const response = await params.hubPoster.post(hub.href, body);
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
