import { createSignal } from "solid-js";
import { storedToggle } from "./preferences.ts";

// Toggles for the new-article signal (#717), kept independent on purpose:
// a badge is free, but background polling costs server load, and an
// operator who wants zero background traffic can turn that off without
// losing the tab-title count.
export const unreadBadge = storedToggle("unreadBadge", true);
export const backgroundPoll = storedToggle("backgroundPoll", true);

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
