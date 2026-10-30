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
