import { isEmailAddress, isWebUrl } from "#shared/validation/address-shape.ts";

const schemePattern = /^[a-z][a-z0-9+.-]*:\/\//iu;

export function withScheme(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || schemePattern.test(trimmed) || isEmailAddress(trimmed))
    return trimmed;
  return `https://${trimmed}`;
}

const httpOnlyMessage = "Enter an HTTP or HTTPS URL.";

export function websiteValidationMessage(link: string): string {
  return isWebUrl(withScheme(link)) ? "" : httpOnlyMessage;
}
