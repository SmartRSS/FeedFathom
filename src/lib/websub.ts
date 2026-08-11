import { createHmac, timingSafeEqual } from "node:crypto";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { isBlockedHostname } from "./private-network-guard.ts";

const subscribeTimeoutMs = 15_000;
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

// RSS commonly advertises a hub via an `atom:` namespaced link even though
// the rest of the feed is plain RSS; HTMLRewriter (a tag-soup scanner, not a
// namespace-aware XML parser) sees that as a literal "atom:link" tag name,
// so both forms need their own selector -- matches the same pattern already
// used for HTML feed-autodiscovery in scanner-page.ts.
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

// JSON Feed (https://www.jsonfeed.org/) has its own hub advertisement --
// a `hubs` array in the feed body -- rather than a Link header or an XML
// <link rel="hub">. Same protocol underneath (a `hubs[].type` of "WebSub"
// means exactly what an XML feed's rel="hub" link means), just a different
// place to look for it.
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

// Resolves relative to the feed's own URL and rejects anything that isn't a
// plain public http(s) URL -- both the hub URL and the topic URL are
// attacker-influenced (they come from whatever the feed's own content or
// headers say), not something a user directly typed in, so this needs the
// same private-network guard as the extension's arbitrary-URL reader fetch.
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
 * Looks for a WebSub hub advertisement in the HTTP response headers first
 * (per spec, the authoritative source when both agree), falling back to the
 * feed body -- most feeds that advertise a hub only do it in the body, but
 * checking headers first matches the spec's own precedence and costs
 * nothing extra since the response was already fetched for parsing.
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

/**
 * POSTs a subscription (or unsubscription) request per the WebSub spec.
 * A 2xx here only means the hub *accepted the request* -- the hub still
 * has to asynchronously GET our callback with a challenge to actually
 * confirm it (see the callback route), so this never marks a source as
 * verified itself.
 */
export async function requestHubSubscription(params: {
  callbackUrl: string;
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
    ...(params.leaseSeconds
      ? { "hub.lease_seconds": String(params.leaseSeconds) }
      : {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), subscribeTimeoutMs);
  try {
    const response = await fetch(hub, {
      body,
      // A hub redirecting the subscribe request is unusual enough (and
      // an SSRF-relevant enough surface, since the redirect target is
      // fully hub-controlled) that treating it as a failure rather than
      // following it automatically is the safer default.
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
    });
    return response.status >= 200 && response.status < 300
      ? { ok: true }
      : { error: `Hub responded with ${response.status}`, ok: false };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies a push notification's `X-Hub-Signature` (or the newer
 * `X-Hub-Signature-256`) against the secret we gave the hub at subscribe
 * time. Constant-time comparison -- this is the only thing standing
 * between "the hub we subscribed to says the feed changed" and "anyone who
 * finds this callback URL can trigger an immediate re-fetch," so a
 * timing side-channel here would defeat the point of having a secret.
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
