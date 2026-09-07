import { createSignal } from "solid-js";

// Prefetching the next article's content (#716) costs the server one extra
// extract-route hit per opened article, and some users count that as waste:
// so this is off until it is switched on.
export type OnOff = "off" | "on";

function isOnOff(value: string): value is OnOff {
  return value === "off" || value === "on";
}

const KEY = "prefetchNext";

function read(): OnOff {
  try {
    const stored = localStorage.getItem(KEY);
    return stored && isOnOff(stored) ? stored : "off";
  } catch {
    return "off";
  }
}

const [prefetchNextEnabled, setPrefetchNextEnabled] =
  createSignal<OnOff>(read());
export { prefetchNextEnabled };

export function setPrefetchNext(next: OnOff) {
  setPrefetchNextEnabled(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {}
}

// Save Data is the user telling every site to send fewer bytes; a
// prefetch is exactly what they asked not to receive. Unknown connection
// objects (Safari, Firefox) read as "no constraint".
export function shouldPrefetch(
  connection: { saveData?: boolean } | undefined,
): boolean {
  return !(connection?.saveData ?? false);
}

// navigator.connection is not in the standard lib types.
export function navigatorConnection(
  navigatorLike: Navigator = navigator,
): { saveData?: boolean } | undefined {
  return (navigatorLike as { connection?: { saveData?: boolean } }).connection;
}
