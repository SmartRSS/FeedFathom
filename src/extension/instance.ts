import { storedInstance } from "#shared/extension-types.ts";
import { canonicalizeInstance } from "./url-helpers.ts";

export const getInstanceUrl = async (): Promise<null | string> => {
  try {
    const instance = storedInstance(await chrome.storage.sync.get("instance"));
    return instance ? (canonicalizeInstance(instance) ?? null) : null;
  } catch {
    return null;
  }
};

// Undefined when the instance is old, unreachable, or ingests no mail; the
// address then falls back to the instance hostname.
export const getMailDomain = async (
  instance: string,
): Promise<string | undefined> => {
  try {
    const response = await fetch(new URL("/api/session", instance).href, {
      credentials: "include",
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const domain =
      typeof body === "object" && body !== null && "mailDomain" in body
        ? body.mailDomain
        : undefined;
    return typeof domain === "string" ? domain : undefined;
  } catch {
    return undefined;
  }
};
