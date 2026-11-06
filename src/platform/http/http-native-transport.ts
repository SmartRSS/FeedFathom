import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as requestHttp,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import { type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  isBlockedAddress,
  isBlockedHostname,
  isIpLiteral,
  normalizeHostname,
} from "#shared/net/private-network-guard.ts";
import { httpUrlWithoutCredentials } from "#shared/util/safe-url.ts";

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
  // Present only for a POST. There is no third method here, so the body's
  // presence is what selects one -- see dispatchNativeRequest.
  body?: string,
) => Promise<NativeHttpResponse>;

type LookupAddress = {
  address: string;
  family: 4 | 6;
};

type PinnedRequest = {
  address: string;
  body: string | undefined;
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

export function parseHttpUrl(value: string): URL {
  const url = httpUrlWithoutCredentials(value);
  if (!url)
    throw new HttpPolicyError(
      "Only HTTP and HTTPS URLs without credentials are allowed",
    );

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new HttpPolicyError("URL hostname is required");
  if (isBlockedHostname(hostname))
    throw new HttpPolicyError(
      isIpLiteral(hostname)
        ? "Non-global IP addresses are not allowed"
        : "Local and internal hostnames are not allowed",
    );
  return url;
}

export function createNativeHttpTransport(
  dependencies: NativeTransportDependencies = {
    dispatch: dispatchNativeRequest,
    lookup: lookupAddresses,
  },
): NativeHttpTransport {
  return async (value, headers, signal, body) => {
    const url = parseHttpUrl(value);
    const normalizedHostname = normalizeHostname(url.hostname);
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
      body,
      family: selected.family,
      headers: requestHeaders,
      path: `${url.pathname}${url.search}`,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      protocol: url.protocol === "https:" ? "https:" : "http:",
      servername: literalFamily ? undefined : normalizedHostname,
      signal,
      url: url.toString(),
    });
  };
}

export const nativeHttpTransport = createNativeHttpTransport();

function ipFamily(address: string): 4 | 6 | undefined {
  const family = isIP(address);
  return family === 4 || family === 6 ? family : undefined;
}

function assertGlobalAddress(
  address: string,
  family: number,
): asserts family is 4 | 6 {
  if ((family !== 4 && family !== 6) || isBlockedAddress(address)) {
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
    method: pinned.body === undefined ? "GET" : "POST",
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
    outgoing.end(pinned.body);
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
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(abortReason(signal)), {
      once: true,
    });
  });
  return Promise.race([operation, aborted]);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The request timed out", "TimeoutError");
}
