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
// Because real HTTP clients accept non-canonical IP literal forms
// (inet_aton-style "2130706433" or "127.1", hex "0x7f.1", octal "017.0.0.1",
// IPv6 zone ids, dotted tails inside IPv4-mapped addresses), a purely
// string-shaped check for dotted quad / canonical IPv6 is not enough. Any
// host that looks IP-ish is normalized to an address before the range
// checks; an IP-ish host we cannot normalize is blocked rather than treated
// as a hostname (fail closed).
type Ipv4Address = [number, number, number, number];

// inet_aton semantics: 1-4 dot-separated parts, each decimal, octal
// (leading 0) or hex (0x); the last part carries the remaining bytes, so
// "127.1" is 127.0.0.1 and "2130706433" is the same address.
const parseIpv4Literal = (hostname: string): Ipv4Address | "blocked" | null => {
  const parts = hostname.split(".");
  if (parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (/^0x[\da-f]+$/i.test(part)) {
      numbers.push(Number.parseInt(part, 16));
    } else if (/^0\d+$/.test(part)) {
      // Octal form: only octal digits parse; "08" is neither octal nor
      // something a client agrees on, so fail closed.
      if (!/^[0-7]+$/.test(part)) return "blocked";
      numbers.push(Number.parseInt(part, 8));
    } else if (/^\d+$/.test(part)) {
      numbers.push(Number.parseInt(part, 10));
    } else {
      // A non-numeric part means this was never an IPv4 literal -- an
      // ordinary hostname like "mirror2.example.com" is fine.
      return null;
    }
  }
  let value = numbers.pop()!;
  for (let index = numbers.length - 1; index >= 0; index--) {
    const number = numbers[index]!;
    if (number > 255) return "blocked";
    value += number * 256 ** (numbers.length - index);
  }
  if (value > 0xffffffff) return "blocked";
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ];
};

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

// Expands "::" into the full eight 16-bit groups; the tail may end in a
// dotted quad (::ffff:127.0.0.1). Malformed addresses return undefined,
// which the caller treats as blocked.
const ipv6Groups = (
  address: string,
):
  | readonly [number, number, number, number, number, number, number, number]
  | undefined => {
  let tail = address;
  if (tail.includes(".")) {
    const dot = tail.lastIndexOf(":");
    if (dot === -1) return undefined;
    const parsed = parseIpv4Literal(tail.slice(dot + 1));
    if (!parsed || parsed === "blocked") return undefined;
    tail = `${tail.slice(0, dot + 1)}${((parsed[0] << 8) | parsed[1]).toString(16)}:${(
      (parsed[2] << 8) |
      parsed[3]
    ).toString(16)}`;
  }

  const sections = tail.split("::");
  if (sections.length > 2) return undefined;
  const head = sections[0] ? sections[0].split(":") : [];
  const back =
    sections.length === 2 ? (sections[1] ? sections[1].split(":") : []) : [];
  const missing = 8 - head.length - back.length;
  if (sections.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [
    ...head,
    ...Array.from<string>({ length: Math.max(missing, 0) }).fill("0"),
    ...back,
  ];
  if (groups.some((group) => !/^[\da-f]{1,4}$/i.test(group))) return undefined;
  const values = groups.map((group) => Number.parseInt(group, 16));
  return [
    values[0]!,
    values[1]!,
    values[2]!,
    values[3]!,
    values[4]!,
    values[5]!,
    values[6]!,
    values[7]!,
  ];
};

const isBlockedIpv6 = (address: string): boolean => {
  // Only IPv6 literals carry a zone id, and only link-local scopes use
  // one (fe80::1%eth0) -- blocked either way.
  if (address.includes("%")) return true;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0) {
      if (g6 === 0 && g7 === 0) return true; // unspecified ::
      if (g6 === 0 && g7 === 1) return true; // loopback ::1
    }
    if (g5 === 0xffff)
      return isBlockedIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  }
  return (
    (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xffc0) === 0xfec0 ||
    (g0 & 0xff00) === 0xff00
  );
};

export const isBlockedHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;

  const ipv4 = parseIpv4Literal(normalized);
  if (ipv4 !== null) {
    return ipv4 === "blocked" ? true : isBlockedIpv4(ipv4);
  }

  if (!normalized.includes(":")) return false;
  return isBlockedIpv6(normalized);
};

// The inverse question, for the internal healthcheck endpoints: an address is
// allowed there only when the request came from this machine. Exact literals
// rather than a range check -- the peer address is one of these three or the
// request is not local.
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const isLoopbackAddress = (address: string): boolean =>
  loopbackAddresses.has(address);
