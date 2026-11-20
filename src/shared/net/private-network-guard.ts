const blockedSubnets = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/96",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

const ipv4Bytes = (address: string): number[] | undefined => {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return undefined;
  return parts.map(Number);
};

const ipv6Bytes = (address: string): number[] | undefined => {
  let groups = address;
  const lastColon = groups.lastIndexOf(":");
  if (groups.includes(".")) {
    const ipv4 = ipv4Bytes(groups.slice(lastColon + 1));
    if (!ipv4) return undefined;
    groups = `${groups.slice(0, lastColon + 1)}${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const sections = groups.split("::");
  if (sections.length > 2) return undefined;
  const head = sections[0] ? sections[0].split(":") : [];
  const back = sections[1] ? sections[1].split(":") : [];
  const missing = 8 - head.length - back.length;
  if (sections.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [
    ...head,
    ...Array<string>(Math.max(missing, 0)).fill("0"),
    ...back,
  ];
  if (all.some((group) => !/^[\da-f]{1,4}$/i.test(group))) return undefined;
  return all.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 255];
  });
};

const addressBytes = (address: string) =>
  address.includes(":") ? ipv6Bytes(address) : ipv4Bytes(address);

const subnets = blockedSubnets.map((subnet) => {
  const [address = "", prefix] = subnet.split("/");
  return { bytes: addressBytes(address)!, prefix: Number(prefix) };
});

const inSubnet = (bytes: number[], subnet: (typeof subnets)[number]) => {
  if (bytes.length !== subnet.bytes.length) return false;
  for (let bit = 0; bit < subnet.prefix; bit += 8) {
    const mask = (0xff << (8 - Math.min(8, subnet.prefix - bit))) & 0xff;
    if (((bytes[bit / 8]! ^ subnet.bytes[bit / 8]!) & mask) !== 0) return false;
  }
  return true;
};

export const isBlockedAddress = (address: string): boolean => {
  const bytes = addressBytes(address.toLowerCase());
  return !bytes || subnets.some((subnet) => inSubnet(bytes, subnet));
};

const internalSuffixes = [
  ".home",
  ".home.arpa",
  ".internal",
  ".lan",
  ".local",
  ".localdomain",
  ".localhost",
];

export const normalizeHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");

export const isIpLiteral = (hostname: string): boolean =>
  hostname.includes(":") || /^[\d.]+$/.test(hostname);

export const isBlockedHostname = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname);
  if (isIpLiteral(normalized)) return isBlockedAddress(normalized);
  return (
    !normalized.includes(".") ||
    internalSuffixes.some((suffix) => normalized.endsWith(suffix))
  );
};

export const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;
  const bytes = addressBytes(normalized);
  if (!bytes) return false;
  if (bytes.length === 4) return bytes[0] === 127;
  return bytes.every((byte, index) => byte === (index === 15 ? 1 : 0));
};
