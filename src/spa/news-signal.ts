import { createSignal } from "solid-js";

// The total unread across every source, written by the dashboard's tree and
// read by the document title. Global by decision: a per-view count would
// depend on which node is selected, and the tab is about the account, not
// the pane. The dashboard resets it to zero when it unmounts (logout).
const [unreadTotal, setUnreadTotal] = createSignal(0);
export { unreadTotal, setUnreadTotal };
