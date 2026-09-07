import { createSignal } from "solid-js";

// Toggles for the new-article signal (#717), kept independent on purpose:
// a badge is free, but background polling costs server load, and an
// operator who wants zero background traffic can turn that off without
// losing the tab-title count.
export type OnOff = "off" | "on";

export function isOnOff(value: string): value is OnOff {
  return value === "off" || value === "on";
}

function storedOnOff(key: string, fallback: OnOff): OnOff {
  try {
    const stored = localStorage.getItem(key);
    return stored && isOnOff(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function onOffSignal(key: string, fallback: OnOff) {
  const [value, setValue] = createSignal<OnOff>(storedOnOff(key, fallback));
  const set = (next: OnOff) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {}
  };
  return [value, set] as const;
}

export const [unreadBadgeEnabled, setUnreadBadgeEnabled] = onOffSignal(
  "unreadBadge",
  "on",
);
export const [backgroundPollEnabled, setBackgroundPollEnabled] = onOffSignal(
  "backgroundPoll",
  "on",
);

// The total unread across every source, written by the dashboard's tree and
// read by the document title. Global by decision: a per-view count would
// depend on which node is selected, and the tab is about the account, not
// the pane. The dashboard resets it to zero when it unmounts (logout).
const [unreadTotal, setUnreadTotal] = createSignal(0);
export { unreadTotal, setUnreadTotal };

// How many articles arrived since the user last refreshed, per the
// background poll; zero means no toast. The dashboard owns both ends.
const [newArticlesCount, setNewArticlesCount] = createSignal(0);
export { newArticlesCount, setNewArticlesCount };
