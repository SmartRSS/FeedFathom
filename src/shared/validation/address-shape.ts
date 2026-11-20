import { httpUrlWithoutCredentials } from "#shared/util/safe-url.ts";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const maxEmailAddressLength = 254;

export function isEmailAddress(value: string): boolean {
  return emailPattern.test(value.trim());
}

export function isWebUrl(value: string): boolean {
  return httpUrlWithoutCredentials(value.trim()) !== undefined;
}
