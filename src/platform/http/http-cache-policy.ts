import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import { webUrlPolicy } from "#shared/validation/typebox-policy.ts";
import type { NativeHttpResponse } from "#platform/http/http-native-transport.ts";

const exact = { additionalProperties: false } as const;

const cachedMetaSchema = Type.Object(
  {
    expiresAt: Type.Number(),
    headers: Type.Array(Type.Tuple([Type.String(), Type.String()])),
    status: Type.Literal(200),
    url: Type.Intersect([Type.String(), webUrlPolicy]),
  },
  exact,
);
export const cachedMetaCheck = Schema.Compile(cachedMetaSchema);

const cachedResponseSchema = Type.Object(
  {
    body: Type.String(),
    expiresAt: Type.Number(),
    headers: Type.Array(Type.Tuple([Type.String(), Type.String()])),
    status: Type.Literal(200),
    url: Type.Intersect([Type.String(), webUrlPolicy]),
  },
  exact,
);
export const cachedResponseCheck = Schema.Compile(cachedResponseSchema);

export type CachedResponse = Static<typeof cachedMetaSchema> & {
  body: Buffer;
};

export function deltaSeconds(value: string): number | undefined {
  const match = /^(?:"(\d+)"|(\d+))$/.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function currentAge(headers: Headers, receivedAt: number): number {
  const responseDate = Date.parse(headers.get("date") ?? "");
  const apparentAge = Number.isFinite(responseDate)
    ? Math.max(0, receivedAt - responseDate)
    : 0;
  const age = deltaSeconds(headers.get("age") ?? "") ?? 0;
  return Math.max(apparentAge, age * 1_000);
}

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

export function cacheable(
  response: Pick<NativeHttpResponse, "headers" | "status" | "url">,
  body: Buffer,
  requestedUrl: string,
): CachedResponse | undefined {
  if (response.status !== 200 || !sharedCacheAllowed(response.headers))
    return undefined;
  const receivedAt = Date.now();
  const expiry = expiresAt(response.headers, receivedAt);
  const hasValidator =
    response.headers.has("etag") || response.headers.has("last-modified");
  if ((expiry === undefined || expiry <= receivedAt) && !hasValidator)
    return undefined;
  return {
    body,
    expiresAt: expiry ?? receivedAt,
    headers: [...response.headers],
    status: 200,
    url: response.url || requestedUrl,
  };
}

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
