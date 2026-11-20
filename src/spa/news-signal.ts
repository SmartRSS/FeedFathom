import { createSignal, type Accessor } from "solid-js";

const [unreadSource, setUnreadSource] = createSignal<Accessor<number>>();

export const unreadTotal = (): number => unreadSource()?.() ?? 0;

export function showUnreadTotal(total: Accessor<number>): () => void {
  setUnreadSource(() => total);
  return () => setUnreadSource(undefined);
}
