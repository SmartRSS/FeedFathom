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
type Ipv4Address = [number, number, number, number];

const ipv4Parts = (hostname: string): Ipv4Address | undefined => {
  const parts = hostname.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)
  )
    return undefined;
  return [
    Number(parts[0]),
    Number(parts[1]),
    Number(parts[2]),
    Number(parts[3]),
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

const mappedIpv4Parts = (hostname: string): Ipv4Address | undefined => {
  if (!hostname.startsWith("::ffff:")) return undefined;
  const parts = hostname.slice(7).split(":");
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
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;

  const ipv4 = ipv4Parts(normalized);
  if (ipv4) return isBlockedIpv4(ipv4);

  if (!normalized.includes(":")) return false;
  if (normalized === "::" || normalized === "::1") return true;

  const mapped = mappedIpv4Parts(normalized);
  if (mapped) return isBlockedIpv4(mapped);

  const first = Number.parseInt(normalized.split(":", 1)[0]!, 16);
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  );
};
