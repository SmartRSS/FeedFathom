import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as requestHttp,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";
import { type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export class HttpPolicyError extends Error {}

export type NativeHttpResponse = {
  body: Readable;
  destroy(error?: Error): void;
  headers: Headers;
  status: number;
  url: string;
};

export type NativeHttpTransport = (
  url: string,
  headers: Headers,
  signal: AbortSignal,
) => Promise<NativeHttpResponse>;

type LookupAddress = {
  address: string;
  family: 4 | 6;
};

type PinnedRequest = {
  address: string;
  family: 4 | 6;
  headers: Headers;
  path: string;
  port: number;
  protocol: "http:" | "https:";
  servername: string | undefined;
  signal: AbortSignal;
  url: string;
};

type NativeTransportDependencies = {
  dispatch(request: PinnedRequest): Promise<NativeHttpResponse>;
  lookup(hostname: string): Promise<readonly LookupAddress[]>;
};

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] satisfies Array<[string, number]>) {
  blockedIpv4Addresses.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] satisfies Array<[string, number]>) {
  blockedIpv6Addresses.addSubnet(address, prefix, "ipv6");
}

const internalSuffixes = [
  ".home",
  ".home.arpa",
  ".internal",
  ".lan",
  ".local",
  ".localdomain",
  ".localhost",
];

export function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpPolicyError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpPolicyError("Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username || url.password) {
    throw new HttpPolicyError("URL credentials are not allowed");
  }

  const hostname = hostnameWithoutBrackets(url.hostname);
  const normalized = hostname.replace(/\.+$/, "").toLowerCase();
  if (!normalized) throw new HttpPolicyError("URL hostname is required");
  const family = ipFamily(normalized);
  if (family) {
    assertGlobalAddress(normalized, family);
  } else if (
    !normalized.includes(".") ||
    normalized === "localhost" ||
    internalSuffixes.some((suffix) => normalized.endsWith(suffix))
  ) {
    throw new HttpPolicyError("Local and internal hostnames are not allowed");
  }
  return url;
}

export function createNativeHttpTransport(
  dependencies: NativeTransportDependencies = {
    dispatch: dispatchNativeRequest,
    lookup: lookupAddresses,
  },
): NativeHttpTransport {
  return async (value, headers, signal) => {
    const url = parseHttpUrl(value);
    const logicalHostname = hostnameWithoutBrackets(url.hostname);
    const normalizedHostname = logicalHostname.replace(/\.+$/, "");
    const literalFamily = ipFamily(normalizedHostname);
    const addresses = literalFamily
      ? [
          {
            address: normalizedHostname,
            family: literalFamily,
          } satisfies LookupAddress,
        ]
      : await raceAbort(dependencies.lookup(normalizedHostname), signal);
    if (addresses.length === 0) {
      throw new HttpPolicyError("Hostname resolved to no addresses");
    }
    for (const address of addresses) {
      if (isIP(address.address) !== address.family) {
        throw new HttpPolicyError("Hostname returned a malformed DNS address");
      }
      assertGlobalAddress(address.address, address.family);
    }

    const selected = addresses[0];
    if (!selected)
      throw new HttpPolicyError("Hostname resolved to no addresses");
    const requestHeaders = new Headers(headers);
    requestHeaders.set("host", url.host);
    return dependencies.dispatch({
      address: selected.address,
      family: selected.family,
      headers: requestHeaders,
      path: `${url.pathname}${url.search}`,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      protocol: url.protocol === "https:" ? "https:" : "http:",
      servername: literalFamily ? undefined : logicalHostname,
      signal,
      url: url.toString(),
    });
  };
}

export const nativeHttpTransport = createNativeHttpTransport();

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function ipFamily(address: string): 4 | 6 | undefined {
  const family = isIP(address);
  return family === 4 || family === 6 ? family : undefined;
}

function assertGlobalAddress(
  address: string,
  family: number,
): asserts family is 4 | 6 {
  if (
    (family !== 4 && family !== 6) ||
    (family === 4
      ? blockedIpv4Addresses.check(address, "ipv4")
      : blockedIpv6Addresses.check(address, "ipv6"))
  ) {
    throw new HttpPolicyError("Non-global IP addresses are not allowed");
  }
}

async function lookupAddresses(hostname: string): Promise<LookupAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new HttpPolicyError("Hostname returned an unsupported DNS family");
    }
    return { address, family };
  });
}

async function dispatchNativeRequest(
  pinned: PinnedRequest,
): Promise<NativeHttpResponse> {
  const headers: Record<string, string> = {};
  for (const [name, value] of pinned.headers) headers[name] = value;
  const options = {
    family: pinned.family,
    headers,
    hostname: pinned.address,
    method: "GET",
    path: pinned.path,
    port: pinned.port,
    signal: pinned.signal,
  } satisfies RequestOptions;

  return new Promise((resolve, reject) => {
    const received = (incoming: IncomingMessage) => {
      try {
        resolve(toNativeResponse(incoming, pinned.url));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    };
    const outgoing =
      pinned.protocol === "https:"
        ? requestHttps(
            pinned.servername
              ? { ...options, servername: pinned.servername }
              : options,
            received,
          )
        : requestHttp(options, received);
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function toNativeResponse(
  incoming: IncomingMessage,
  url: string,
): NativeHttpResponse {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }

  const streams: Readable[] = [incoming];
  let body: Readable = incoming;
  const encodings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding && encoding !== "identity")
    .toReversed();
  for (const encoding of encodings) {
    const decoder =
      encoding === "gzip" || encoding === "x-gzip"
        ? createGunzip()
        : encoding === "deflate"
          ? createInflate()
          : encoding === "br"
            ? createBrotliDecompress()
            : undefined;
    if (!decoder) {
      for (const stream of streams) stream.destroy();
      throw new HttpPolicyError(`Unsupported content encoding: ${encoding}`);
    }
    body.once("error", (error: Error) => decoder.destroy(error));
    body = body.pipe(decoder);
    streams.push(decoder);
  }

  return {
    body,
    destroy(error) {
      for (const stream of streams) stream.destroy(error);
    },
    headers,
    status: incoming.statusCode ?? 0,
    url,
  };
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: Error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The request timed out", "TimeoutError");
}
