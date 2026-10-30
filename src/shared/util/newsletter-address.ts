// A newsletter subscription is a source whose URL is an address the mail
// ingest routes back here. The SPA mints it without a round trip, so it only
// has to be unguessable and unique; the server checks the same format before
// reserving one, so a client cannot create email sources of its own choosing.

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

// Compared lowercase: recipients and subscription targets are canonicalised
// to lowercase before they are matched against sources.url.
export function isNewsletterAddress(address: string, domain: string): boolean {
  const [localPart, host, ...rest] = address.toLowerCase().split("@");
  return (
    rest.length === 0 &&
    host === domain.toLowerCase() &&
    /^[\da-f]{16}$/u.test(localPart ?? "")
  );
}
