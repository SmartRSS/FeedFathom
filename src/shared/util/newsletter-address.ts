// A newsletter subscription is a source whose URL is an address the mail
// ingest routes back here. The SPA mints it without a round trip, so it only
// has to be unguessable and unique. Only an address in a format minted here,
// on this instance's mail domain, can create a source; the address then
// belongs to the account that created it. Otherwise an account could take
// admin@ or postmaster@, which certificate authorities mail to validate the
// domain.

export function newsletterAddress(domain: string): string {
  return `${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}@${domain}`;
}

const mintedLocalPart = /^[\da-f]{16}$/u;
// The dashed UUID older extensions minted. Installed ones still do.
const extensionLocalPart = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;

// Compared lowercase: recipients and subscription targets are canonicalised
// to lowercase before they are matched against sources.url.
const hasLocalPart = (address: string, domain: string, pattern: RegExp) => {
  const [localPart, host, ...rest] = address.toLowerCase().split("@");
  return (
    rest.length === 0 &&
    host === domain.toLowerCase() &&
    pattern.test(localPart ?? "")
  );
};

// What newsletterAddress mints. The reservation endpoint, which only the SPA
// calls, accepts nothing else.
export function isNewsletterAddress(address: string, domain: string): boolean {
  return hasLocalPart(address, domain, mintedLocalPart);
}

// What subscribe may create a source for: the minted format or an older
// extension's.
export function isMintedNewsletterAddress(
  address: string,
  domain: string,
): boolean {
  return (
    isNewsletterAddress(address, domain) ||
    hasLocalPart(address, domain, extensionLocalPart)
  );
}
