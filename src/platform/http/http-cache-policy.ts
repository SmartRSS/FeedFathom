import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import { webUrlPolicy } from "#shared/validation/typebox-policy.ts";
import type { NativeHttpResponse } from "#platform/http/http-native-transport.ts";

// HTTP cache semantics: whether a response may be held in a shared cache, how
// long it stays fresh, and how a 304 refreshes what is already stored. Pure
// functions of headers and a clock, so every rule below can be answered
// without a cache to store anything in.

const exact = { additionalProperties: false } as const;

const cachedResponseSchema = Type.Object(
  {
    body: Type.String(),
    expiresAt: Type.Number(),
    headers: Type.Array(Type.Tuple([Type.String(), Type.String()])),
    status: Type.Number(),
    url: Type.Intersect([Type.String(), webUrlPolicy]),
  },
  exact,
);
export const cachedResponseCheck = Schema.Compile(cachedResponseSchema);

export type CachedResponse = Static<typeof cachedResponseSchema>;

/**
 * A delta-seconds header value. Only a bare non-negative integer counts --
 * optionally quoted, because some origins quote Age. Anything else is absent
 * rather than zero, so a malformed value falls through to the next rule
 * instead of pinning freshness to now.
 */
export function deltaSeconds(value: string): number | undefined {
  const match = /^(?:"(\d+)"|(\d+))$/.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * How old the response already was when it arrived: the greater of the gap
 * since its Date and whatever Age an intermediary reported. Taking the greater
 * means a lying intermediary can shorten our freshness but never extend it.
 */
export function currentAge(headers: Headers, receivedAt: number): number {
  const responseDate = Date.parse(headers.get("date") ?? "");
  const apparentAge = Number.isFinite(responseDate)
    ? Math.max(0, receivedAt - responseDate)
    : 0;
  const age = deltaSeconds(headers.get("age") ?? "") ?? 0;
  return Math.max(apparentAge, age * 1_000);
}

/**
 * Whether this response may go in a cache shared by every user of the
 * instance. A response carrying no-store, private, Vary: * or a Set-Cookie is
 * about one requester and must not be replayed to another.
 */
export function sharedCacheAllowed(headers: Headers): boolean {
  const directives = new Set(
    (headers.get("cache-control") ?? "")
      .toLowerCase()
      .split(",")
      .map((directive) => directive.trim().split("=", 1)[0]),
  );
  return !(
    directives.has("no-store") ||
    directives.has("private") ||
    headers.get("vary")?.trim() === "*" ||
    headers.has("set-cookie")
  );
}

/**
 * The instant this response stops being fresh, or undefined when nothing says.
 *
 * s-maxage outranks max-age because this is a shared cache. A repeated or
 * unparseable max-age expires immediately rather than being guessed at. The
 * age the response already carries is subtracted from its lifetime, so a
 * response that spent its whole max-age in an intermediary arrives stale.
 */
export function expiresAt(
  headers: Headers,
  receivedAt = Date.now(),
): number | undefined {
  const directives = (headers.get("cache-control") ?? "")
    .split(",")
    .map((directive) => {
      const [name = "", value = ""] = directive.trim().split("=", 2);
      return [name.toLowerCase(), value.trim()] as const;
    })
    .filter(([name]) => name);
  if (directives.some(([name]) => name === "no-cache")) return receivedAt;

  const sharedMaxAge = directives.filter(([name]) => name === "s-maxage");
  const maxAgeDirectives = sharedMaxAge.length
    ? sharedMaxAge
    : directives.filter(([name]) => name === "max-age");
  if (maxAgeDirectives.length > 1) return receivedAt;

  const age = currentAge(headers, receivedAt);
  const maxAgeValue = maxAgeDirectives[0]?.[1];
  if (maxAgeValue !== undefined) {
    const maxAge = deltaSeconds(maxAgeValue);
    if (maxAge === undefined) return receivedAt;
    return receivedAt + Math.max(0, maxAge * 1_000 - age);
  }

  const expires = Date.parse(headers.get("expires") ?? "");
  if (!Number.isFinite(expires)) return undefined;
  const responseDate = Date.parse(headers.get("date") ?? "");
  const freshnessLifetime = Math.max(
    0,
    expires - (Number.isFinite(responseDate) ? responseDate : receivedAt),
  );
  return receivedAt + Math.max(0, freshnessLifetime - age);
}

/**
 * The cache entry for a response, or undefined if it is not worth storing.
 *
 * Already-stale is still worth storing when the response carries a validator,
 * because that turns the next fetch into a conditional request that can come
 * back 304 instead of re-downloading the body.
 */
export function cacheable(
  response: Pick<NativeHttpResponse, "headers" | "status" | "url">,
  body: Buffer,
  requestedUrl: string,
): CachedResponse | undefined {
  if (!sharedCacheAllowed(response.headers)) return undefined;
  const receivedAt = Date.now();
  const expiry = expiresAt(response.headers, receivedAt);
  const hasValidator =
    response.headers.has("etag") || response.headers.has("last-modified");
  if ((expiry === undefined || expiry <= receivedAt) && !hasValidator)
    return undefined;
  return {
    body: body.toString("base64"),
    expiresAt: expiry ?? receivedAt,
    headers: [...response.headers],
    status: response.status,
    url: response.url || requestedUrl,
  };
}

/**
 * Fold a 304's headers into the stored entry and recompute when it expires.
 *
 * Age is dropped unless the 304 restated it, and Date is stamped to now if the
 * 304 omitted it -- otherwise the stored copy's original Date would make the
 * refreshed entry look as old as the response it replaced.
 */
export function refresh(
  cached: CachedResponse,
  headers: Headers,
): CachedResponse {
  const merged = new Headers(cached.headers);
  for (const [name, value] of headers) merged.set(name, value);
  if (!headers.has("age")) merged.delete("age");
  if (!headers.has("date")) merged.set("date", new Date().toUTCString());
  return {
    ...cached,
    expiresAt: expiresAt(merged) ?? Date.now(),
    headers: [...merged],
  };
}
