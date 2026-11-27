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
  for (const part of value.split(",")) {
    const urlMatch = /<([^>]+)>/.exec(part);
    const relMatch = /rel=["']?([^"';]+)["']?/i.exec(part);
    if (!urlMatch || !relMatch) continue;
    const rel = relMatch[1]!.toLowerCase();
    if (!rels.has(rel)) rels.set(rel, urlMatch[1]!);
  }
  return rels;
}

let activeBodyRels: Map<string, string> | undefined;

const webSubLinkRewriter = new HTMLRewriter().on(
  "link[rel], atom\\:link[rel]",
  {
    element(element) {
      const rel = element.getAttribute("rel")?.toLowerCase();
      const href = element.getAttribute("href");
      if (rel && href && activeBodyRels && !activeBodyRels.has(rel)) {
        activeBodyRels.set(rel, href);
      }
    },
  },
);

function scanFeedBodyRels(xml: string): Map<string, string> {
  const rels = new Map<string, string>();
  activeBodyRels = rels;
  try {
    webSubLinkRewriter.transform(xml);
  } finally {
    activeBodyRels = undefined;
  }
  return rels;
}

function resolvePublicUrl(value: string, base?: string): string | undefined {
  try {
    return parseHttpUrl(new URL(value, base).href).href;
  } catch {
    return undefined;
  }
}

const relAttributePattern = /\brel\s*=/i;

export function hasHeaderWebSubHub(headers: Headers): boolean {
  return parseLinkHeaderRels(headers.get("link") ?? "").has("hub");
}

function bodyLinkRels(
  body: ReadonlyMap<string, string> | string,
): ReadonlyMap<string, string> | undefined {
  if (typeof body !== "string") return body;
  return relAttributePattern.test(body) ? scanFeedBodyRels(body) : undefined;
}

export function discoverWebSub(
  headers: Headers,
  body: ReadonlyMap<string, string> | string,
  feedUrl: string,
  jsonFeedHubUrl?: string,
): WebSubDiscovery | undefined {
  const headerRels = parseLinkHeaderRels(headers.get("link") ?? "");
  const bodyRels =
    headerRels.has("hub") && headerRels.has("self")
      ? undefined
      : bodyLinkRels(body);

  const hubUrl =
    headerRels.get("hub") ?? bodyRels?.get("hub") ?? jsonFeedHubUrl;
  if (!hubUrl) return undefined;
  const topicUrl = headerRels.get("self") ?? bodyRels?.get("self") ?? feedUrl;

  const resolvedHub = resolvePublicUrl(hubUrl, feedUrl);
  const resolvedTopic = resolvePublicUrl(topicUrl, feedUrl);
  if (!resolvedHub || !resolvedTopic) return undefined;

  return { hubUrl: resolvedHub, topicUrl: resolvedTopic };
}

export const webSubCallbackPath = <Token extends string>(
  token: Token,
): `/api/websub/callback/${Token}` => `/api/websub/callback/${token}`;

type HubSubscriptionResult = { ok: true } | { error: string; ok: false };

export type HubPoster = {
  post(url: string, body: URLSearchParams): Promise<{ status: number }>;
};

export async function requestHubSubscription(params: {
  callbackToken: string;
  publicOrigin: URL;
  hubPoster: HubPoster;
  hubUrl: string;
  secret: string;
  topicUrl: string;
}): Promise<HubSubscriptionResult> {
  const hub = resolvePublicUrl(params.hubUrl);
  if (!hub)
    return { error: "Hub URL is not a public http or https URL", ok: false };

  const body = new URLSearchParams({
    "hub.callback": new URL(
      webSubCallbackPath(params.callbackToken),
      params.publicOrigin,
    ).href,
    "hub.mode": "subscribe",
    "hub.secret": params.secret,
    "hub.topic": params.topicUrl,
    "hub.verify": "async",
  });

  try {
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
