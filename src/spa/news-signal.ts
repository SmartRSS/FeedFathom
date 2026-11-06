import { createSignal } from "solid-js";

// dashboard.tsx still imports the toggle from here.
export { backgroundPoll } from "./preferences.ts";

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
