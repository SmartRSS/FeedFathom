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

// Narrower than typeof fetch: tests can stub it without Response's full
// static surface, and the extension only ever calls it with a string URL.
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

// The cheapest request that proves the address is a reachable FeedFathom:
// /api/session answers 200 whether or not anyone is signed in, which is what
// the options page's "Test connection" button reports on. False rather than a
// thrown error because "why" is the caller's message to write, not ours.
export const pingInstance = async (
  instance: string,
  fetchImplementation: FetchLike = fetch,
): Promise<boolean> => {
  const origin = canonicalizeInstance(instance);
  if (!origin) return false;
  try {
    const response = await fetchImplementation(
      new URL("/api/session", origin).href,
      { credentials: "include" },
    );
    return response.ok;
  } catch {
    return false;
  }
};
