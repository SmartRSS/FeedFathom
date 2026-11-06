// The shape checks behind the server's email and URL policies, dependency
// free so a client checks a form field by the same rule before sending it.

import { httpUrlWithoutCredentials } from "#shared/util/safe-url.ts";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

// RFC 5321 caps a forward path at 256 octets, brackets included, so no
// deliverable address is longer than 254.
export const maxEmailAddressLength = 254;

export function isEmailAddress(value: string): boolean {
  return emailPattern.test(value.trim());
}

export function isWebUrl(value: string): boolean {
  return httpUrlWithoutCredentials(value.trim()) !== undefined;
}
