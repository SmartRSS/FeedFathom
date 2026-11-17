import { createSignal, type Accessor } from "solid-js";

// The total unread across every source, from the dashboard's tree, read by
// the document title. Global by decision: a per-view count would depend on
// which node is selected, and the tab is about the account, not the pane.
// Zero while no dashboard is mounted, so a logged-out tab keeps no count.
const [unreadSource, setUnreadSource] = createSignal<Accessor<number>>();

export const unreadTotal = (): number => unreadSource()?.() ?? 0;

/** For the dashboard's onSettled: the returned cleanup hands the total back. */
export function showUnreadTotal(total: Accessor<number>): () => void {
  setUnreadSource(() => total);
  return () => setUnreadSource(undefined);
}
