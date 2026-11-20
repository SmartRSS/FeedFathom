export function newsletterAddress(domain: string): string {
  return `${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}@${domain}`;
}

const mintedLocalPart = /^[\da-f]{16}$/u;
const extensionLocalPart = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;

const hasLocalPart = (address: string, domain: string, pattern: RegExp) => {
  const [localPart, host, ...rest] = address.toLowerCase().split("@");
  return (
    rest.length === 0 &&
    host === domain.toLowerCase() &&
    pattern.test(localPart ?? "")
  );
};

export function isNewsletterAddress(address: string, domain: string): boolean {
  return hasLocalPart(address, domain, mintedLocalPart);
}

export function isMintedNewsletterAddress(
  address: string,
  domain: string,
): boolean {
  return (
    isNewsletterAddress(address, domain) ||
    hasLocalPart(address, domain, extensionLocalPart)
  );
}
