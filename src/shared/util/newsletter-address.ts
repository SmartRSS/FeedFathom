// A newsletter subscription is a source whose URL is an address the mail
// ingest routes back here. The SPA mints it without a round trip, so it only
// has to be unguessable and unique. Only an address in a format minted here,
// on this instance's mail domain, can create a source; the address then
// belongs to the account that created it. Otherwise an account could take
// admin@ or postmaster@, which certificate authorities mail to validate the
// domain.

// The host addresses are minted at, or undefined unless this deployment
// ingests mail. FEED_FATHOM_DOMAIN is only a fallback for the single-domain
// case: the address host is wherever inbound mail is routed, which is a
// separate deployment decision. Either way it carries the public port for link
// building (localhost:3456 in dev), and an address host never has one.
// First non-blank wins rather than first non-nullish: compose.yml passes
// MAIL_DOMAIN through as `${MAIL_DOMAIN:-}`, so an unset variable arrives as
// "" and a `??` chain would let it shadow the fallback -- which is how
// production silently stopped advertising a newsletter host at all.
export function newsletterMailDomain(config: {
  FEED_FATHOM_DOMAIN?: string | undefined;
  MAIL_DOMAIN?: string | undefined;
  MAIL_ENABLED: boolean;
}): string | undefined {
  if (!config.MAIL_ENABLED) return undefined;
  return [config.MAIL_DOMAIN, config.FEED_FATHOM_DOMAIN]
    .map((host) => host?.trim())
    .find(Boolean)
    ?.replace(/:\d+$/u, "");
}

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
