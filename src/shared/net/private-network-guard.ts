// Shared by the extension's reader-fetch (src/extension/reader-fetch.ts) and
// server-side outbound requests whose target URL comes from untrusted,
// attacker-influenced content rather than something a user directly typed
// (a WebSub hub URL discovered inside fetched feed content, for example).
// Checks the hostname string itself, not a DNS-resolved address -- same
// limitation as the extension's original version, so this does not defend
// against DNS rebinding (a hostname that resolves to a private IP at
// request time). Closing that gap would mean resolving DNS ourselves and
// connecting to the resolved address directly, which neither call site
// does today.
//
// Within that limit it fails closed: only a canonical dotted quad and a
// leading IPv6 group it can read are treated as addresses to range-check.
// Anything that merely looks like an address -- and so might be resolved as
// one by something with different rules than ours -- is blocked outright.
type Ipv4Address = [number, number, number, number];

// Canonical dotted-quad only: no leading zeros, because inet_aton reads a
// leading zero as octal and would connect to a different address than the
// one this function decoded. 0177.0.0.1 is 127.0.0.1 to the transport and
// 177.0.0.1 to Number().
const canonicalOctet = /^(?:0|[1-9]\d{0,2})$/;

const ipv4Parts = (hostname: string): Ipv4Address | undefined => {
  const parts = hostname.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !canonicalOctet.test(part) || Number(part) > 255)
  )
    return undefined;
  return [
    Number(parts[0]),
    Number(parts[1]),
    Number(parts[2]),
    Number(parts[3]),
  ];
};

// A label that is entirely numeric, or a hex literal, cannot be a DNS label
// anyone will resolve -- no registry issues an all-digit TLD. So a hostname
// ending in one is an address written in some spelling other than the
// canonical quad above: a bare integer (2130706433), an octal octet
// (0177.0.0.1), a hex literal (0x7f.1), a short form (127.1). inet_aton
// accepts every one of them and they all reach 127.0.0.1.
//
// These are blocked rather than decoded. Reproducing inet_aton exactly would
// mean matching whatever the transport's resolver does, and being wrong in
// either direction is a hole; there is no legitimate host of this shape to
// lose by refusing them outright.
const numericLabel = /^(?:\d+|0x[\da-f]+)$/i;

const isBlockedIpv4 = ([first, second]: Ipv4Address): boolean =>
  first === 0 ||
  first === 10 ||
  first === 127 ||
  (first === 100 && second >= 64 && second <= 127) ||
  (first === 169 && second === 254) ||
  (first === 172 && second >= 16 && second <= 31) ||
  (first === 192 && second === 168) ||
  (first === 198 && (second === 18 || second === 19)) ||
  first >= 224;

// Both spellings of a v4-mapped address: ::ffff:7f00:1 and the dotted
// ::ffff:127.0.0.1 the URL parser and getpeername both prefer.
const mappedIpv4Parts = (hostname: string): Ipv4Address | undefined => {
  if (!hostname.startsWith("::ffff:")) return undefined;
  const tail = hostname.slice(7);
  const dotted = ipv4Parts(tail);
  if (dotted) return dotted;
  const parts = tail.split(":");
  if (parts.length !== 2 || parts.some((part) => !/^[\da-f]{1,4}$/i.test(part)))
    return undefined;
  const high = Number.parseInt(parts[0]!, 16);
  const low = Number.parseInt(parts[1]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
};

export const isBlockedHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    // A zone id only ever qualifies a link-local address, which is blocked
    // below on its prefix. Dropping it keeps it out of the group parsing.
    .replace(/%.*$/, "")
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;

  const ipv4 = ipv4Parts(normalized);
  if (ipv4) return isBlockedIpv4(ipv4);

  if (!normalized.includes(":")) {
    // Not a name and not a canonical address, so it is one of the spellings
    // above that we refuse to guess at.
    return numericLabel.test(normalized.split(".").at(-1) ?? "");
  }
  if (normalized === "::" || normalized === "::1") return true;

  const mapped = mappedIpv4Parts(normalized);
  if (mapped) return isBlockedIpv4(mapped);

  // A colon in a hostname means an IPv6 literal, so the leading group decides
  // it. Global unicast is 2000::/3 and every allocation under it starts with
  // a non-zero group, so a leading zero -- or a group that does not parse at
  // all -- is some compressed or uncommon form whose meaning we would be
  // guessing at: ::ffff:0:7f00:1, 0:0:0:0:0:ffff:7f00:1, and every other way
  // of writing loopback that the two branches above do not recognise.
  const first = Number.parseInt(normalized.split(":", 1)[0]!, 16);
  return (
    !first ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  );
};

// The inverse question, for the internal healthcheck endpoints: an address is
// allowed there only when the request came from this machine. Exact literals
// rather than a range check -- the peer address is one of these three or the
// request is not local.
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const isLoopbackAddress = (address: string): boolean =>
  loopbackAddresses.has(address);
