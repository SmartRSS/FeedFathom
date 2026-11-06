import {
  createEffect,
  createRoot,
  on,
  onCleanup,
  type Accessor,
} from "solid-js";
import { maximumRequestIds } from "#shared/contracts/requests.ts";
import type { TreeNode } from "#shared/contracts/responses.ts";
import { sourceIds } from "./feed-tree.ts";
import { offlineUnread } from "./preferences.ts";
import { saveData } from "./reading-prefetch.ts";
import { postToWorker } from "./sw-protocol.ts";
import { browserTimers, type Timers } from "./timers.ts";

// The service worker can't read localStorage: the dashboard sends it the
// sources with unread articles, and switching offline reading off, here or in
// another tab, sends none, so the worker drops what it kept.
createRoot(() =>
  createEffect(
    on(
      offlineUnread.get,
      (enabled) => {
        if (!enabled) postOfflineSync([]);
      },
      { defer: true },
    ),
  ),
);

// The worker lists and downloads the unread articles of these sources.
function postOfflineSync(sources: number[]) {
  postToWorker({ sources, type: "offline-sync" });
}

// Only sources with something unread are asked about. ponytail: one article
// request accepts 500 source ids, so past that many sources with unread the
// rest go undownloaded; a server-side "every subscription" unread scope
// lifts it.
export function unreadSourceIds(nodes: readonly TreeNode[]): number[] {
  return nodes
    .flatMap((node) => sourceIds(node, (source) => source.unreadCount > 0))
    .slice(0, maximumRequestIds);
}

// Offline reading (#992) tells the service worker which unread bodies to
// keep. Tree loads pace it: the stream and the poll reload the tree when
// articles arrive, and marking read or removing reloads it too. It runs at
// most once a minute, in idle time.
const minimumSpacingMs = 60_000;

type OfflineSyncOptions = {
  // Whether this tab may sync at all.
  wanted(): boolean;
  // Whether a sync can run at this moment.
  ready(): boolean;
  sync(): void;
  idle?(run: () => void): void;
  timers?: Timers;
};

export class OfflineSyncPacer {
  readonly #options: OfflineSyncOptions;
  readonly #timers: Timers;
  #timer: unknown;
  #syncedAt = Number.NEGATIVE_INFINITY;
  #disposed = false;

  constructor(options: OfflineSyncOptions) {
    this.#options = options;
    this.#timers = options.timers ?? browserTimers;
  }

  request(): void {
    this.#timers.clear(this.#timer);
    if (this.#disposed || !this.#options.wanted()) return;
    const idle = this.#options.idle ?? ((run: () => void) => run());
    this.#timer = this.#timers.set(
      () => idle(() => this.#run()),
      Math.max(0, this.#syncedAt + minimumSpacingMs - this.#timers.now()),
    );
  }

  dispose(): void {
    this.#disposed = true;
    this.#timers.clear(this.#timer);
  }

  #run(): void {
    if (this.#disposed || !this.#options.wanted() || !this.#options.ready())
      return;
    this.#syncedAt = this.#timers.now();
    this.#options.sync();
  }
}

/** Syncs after each tree change, and again when the tab, the network or
 *  the worker comes back: a sync may have stopped short when it went. */
export function createOfflineSync(
  tree: Accessor<TreeNode[]>,
  signedIn: Accessor<boolean>,
): void {
  const pacer = new OfflineSyncPacer({
    idle: (run) => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(run);
      else run();
    },
    // Save Data, a hidden or offline tab, or no worker to receive it.
    ready: () =>
      !saveData() &&
      !document.hidden &&
      navigator.onLine &&
      Boolean(navigator.serviceWorker?.controller),
    sync: () => postOfflineSync(unreadSourceIds(tree())),
    wanted: () => signedIn() && offlineUnread.get(),
  });
  createEffect(() => {
    tree();
    pacer.request();
  });
  const retry = () => pacer.request();
  document.addEventListener("visibilitychange", retry);
  addEventListener("online", retry);
  navigator.serviceWorker?.addEventListener("controllerchange", retry);
  onCleanup(() => {
    pacer.dispose();
    document.removeEventListener("visibilitychange", retry);
    removeEventListener("online", retry);
    navigator.serviceWorker?.removeEventListener("controllerchange", retry);
  });
}
