import { storedBadgeEnabled } from "#shared/extension-types.ts";

// The toolbar badge is the only hint, short of opening the popup, that the
// content script found feeds on the current page. The colour is the icon's
// own orange (src/spa/assets/*-inverted-round.png), so the badge reads as
// part of the button rather than a notification pasted onto it.
export const badgeColor = "#ff7f00";

// Same shape as the instance address: a chrome.storage.sync key read per
// use through a shared helper, defaulting to on when never set (#768).
export const getBadgeEnabled = async (): Promise<boolean> => {
  try {
    return storedBadgeEnabled(await chrome.storage.sync.get("showBadge"));
  } catch {
    return true;
  }
};

// Chrome clips badge text to about four characters and Firefox to fewer;
// "99+" is the conventional ceiling. Zero feeds clears the badge entirely --
// an inert-looking button is honest when there is nothing to subscribe to.
export const formatBadgeCount = (count: number): string => {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count > 99) return "99+";
  return String(count);
};
