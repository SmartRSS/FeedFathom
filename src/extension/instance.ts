import { readSettings } from "./settings.ts";
import {
  canonicalizeInstance,
  targetUrl,
  type InstanceOrigin,
  type OpenTarget,
} from "./url-helpers.ts";

export const getInstanceUrl = async (): Promise<InstanceOrigin | null> => {
  const { instance } = await readSettings();
  if (instance === undefined) return null;
  return canonicalizeInstance(instance) ?? null;
};

// With no instance configured, a target that needs one opens the options
// page, where the user can set it.
export const openTarget = async (target: OpenTarget): Promise<void> => {
  const url = targetUrl(target, await getInstanceUrl());
  if (url) await chrome.tabs.create({ url });
  else await chrome.runtime.openOptionsPage();
};

// Narrower than typeof fetch: tests can stub it without Response's full
// static surface, and the extension only ever calls it with a string URL.
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

// The cheapest request that proves the address is a reachable FeedFathom:
// /api/session answers 200 whether or not anyone is signed in, which is what
// the options page's "Test connection" button reports on. False rather than a
// thrown error because "why" is the caller's message to write, not ours.
export const pingInstance = async (
  instance: InstanceOrigin,
  fetchImplementation: FetchLike = fetch,
): Promise<boolean> => {
  try {
    const response = await fetchImplementation(`${instance}/api/session`, {
      credentials: "include",
    });
    return response.ok;
  } catch {
    return false;
  }
};
