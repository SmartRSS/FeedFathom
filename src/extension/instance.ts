import type { Fetch } from "./reader-fetch.ts";
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

export const openTarget = async (target: OpenTarget): Promise<void> => {
  const url = targetUrl(target, await getInstanceUrl());
  if (url) await chrome.tabs.create({ url });
  else await chrome.runtime.openOptionsPage();
};

export const pingInstance = async (
  instance: InstanceOrigin,
  fetchImplementation: Fetch = fetch,
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
