import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  feedDataSchema,
  type FeedData,
} from "#shared/scanners/feed-data-type.ts";

// The options the user sets, kept in chrome.storage.sync.
type StoredSettings = {
  instance: string;
  showBadge: boolean;
  showOpenRss: boolean;
};
type Settings = Omit<StoredSettings, "instance"> & {
  instance: string | undefined;
};

// Each key is read on its own, so one unreadable value falls back to its
// default without resetting the others.
export const settingsFrom = (stored: Record<string, unknown>): Settings => ({
  instance:
    typeof stored["instance"] === "string" ? stored["instance"] : undefined,
  // The toolbar badge is opt-out (#768): only an explicit false turns it
  // off, so a storage failure never silently turns the feature off.
  showBadge: stored["showBadge"] !== false,
  // The OpenRSS suggestion is opt-in: it sends the page address to a third
  // party, so only an explicit true turns it on.
  showOpenRss: stored["showOpenRss"] === true,
});

export const readSettings = async (): Promise<Settings> => {
  try {
    return settingsFrom(await chrome.storage.sync.get(null));
  } catch {
    return settingsFrom({});
  }
};

export const writeSettings = (
  changes: Partial<StoredSettings>,
): Promise<void> => chrome.storage.sync.set(changes);

export const clearInstance = (): Promise<void> =>
  chrome.storage.sync.remove("instance");

export const onBadgeTurnedOff = (callback: () => void): void => {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && changes["showBadge"]?.newValue === false)
      callback();
  });
};

// The feeds the content script last reported, kept in session storage for
// the popup, which may open after that report.
const foundFeedsSchema = Type.Array(feedDataSchema);

export const storeFoundFeeds = (feeds: FeedData[]): Promise<void> =>
  chrome.storage.session.set({ feedsData: feeds });

export const forgetFoundFeeds = (): Promise<void> =>
  chrome.storage.session.remove("feedsData");

export const readFoundFeeds = async (): Promise<FeedData[] | undefined> => {
  const { feedsData } = await chrome.storage.session.get("feedsData");
  return Value.Check(foundFeedsSchema, feedsData) ? feedsData : undefined;
};
