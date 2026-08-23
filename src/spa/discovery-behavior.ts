const schemePattern = /^[a-z][a-z0-9+.-]*:\/\//iu;

// A bare "example.com" is what people type; a mail address is what they type
// when subscribing a newsletter, and prefixing that would produce nonsense.
export function withScheme(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || schemePattern.test(trimmed) || trimmed.includes("@"))
    return trimmed;
  return `https://${trimmed}`;
}

const httpOnlyMessage = "Enter an HTTP or HTTPS URL.";

/**
 * The browser's own constraint-validation message for the website field: the
 * empty string means valid. Anything that is not http(s) is rejected here
 * rather than at the server, including the javascript: and data: schemes a
 * pasted value can carry.
 */
export function websiteValidationMessage(link: string): string {
  try {
    const { protocol } = new URL(withScheme(link));
    return protocol === "http:" || protocol === "https:" ? "" : httpOnlyMessage;
  } catch {
    return httpOnlyMessage;
  }
}

// A preview lands on its first article, or on nothing when the feed is empty.
export function initialPreviewSelection(
  articleCount: number,
): number | undefined {
  return articleCount ? 0 : undefined;
}

export type ClickModifiers = {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

// A modified click is the browser's gesture for "open this elsewhere", so the
// pane must not swallow it by selecting instead.
export function clickSelectsArticle(modifiers: ClickModifiers): boolean {
  return !(
    modifiers.ctrlKey === true ||
    modifiers.metaKey === true ||
    modifiers.shiftKey === true ||
    modifiers.altKey === true
  );
}

// A newsletter subscription is just a source whose URL is an address the mail
// ingest routes back here, so the address only has to be unguessable and
// unique -- no server round trip needed to mint one.
export function newsletterAddress(domain: string): string {
  return `${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}@${domain}`;
}
