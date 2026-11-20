import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  feedDataSchema,
  type FeedData,
} from "#shared/scanners/feed-data-type.ts";

type StoredSettings = {
  instance: string;
  showBadge: boolean;
  showOpenRss: boolean;
};
type Settings = Omit<StoredSettings, "instance"> & {
  instance: string | undefined;
};

export const settingsFrom = (stored: Record<string, unknown>): Settings => ({
  instance:
    typeof stored["instance"] === "string" ? stored["instance"] : undefined,
  showBadge: stored["showBadge"] !== false,
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

const foundFeedsSchema = Type.Array(feedDataSchema);

export const storeFoundFeeds = (feeds: FeedData[]): Promise<void> =>
  chrome.storage.session.set({ feedsData: feeds });

export const forgetFoundFeeds = (): Promise<void> =>
  chrome.storage.session.remove("feedsData");

export const readFoundFeeds = async (): Promise<FeedData[] | undefined> => {
  const { feedsData } = await chrome.storage.session.get("feedsData");
  return Value.Check(foundFeedsSchema, feedsData) ? feedsData : undefined;
};
