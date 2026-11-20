import {
  createEffect,
  createRoot,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import { maximumRequestIds } from "#shared/contracts/limits.ts";
import type { TreeNode } from "#shared/contracts/responses.ts";
import { sourceIds } from "./feed-tree.ts";
import { offlineUnread } from "./preferences.ts";
import { saveData } from "./reading-prefetch.ts";
import { postOfflineSync } from "./sw-protocol.ts";
import { browserTimers, type Timers } from "./timers.ts";

createRoot(() =>
  createEffect(
    offlineUnread.get,
    (enabled) => {
      if (!enabled) postOfflineSync([]);
    },
    { defer: true },
  ),
);

export function unreadSourceIds(nodes: readonly TreeNode[]): number[] {
  return nodes
    .flatMap((node) => sourceIds(node, (source) => source.unreadCount > 0))
    .slice(0, maximumRequestIds);
}

const minimumSpacingMs = 60_000;

type OfflineSyncOptions = {
  wanted(): boolean;
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

export function createOfflineSync(
  tree: Accessor<TreeNode[]>,
  signedIn: Accessor<boolean>,
): void {
  const pacer = new OfflineSyncPacer({
    idle: (run) => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(run);
      else run();
    },
    ready: () =>
      !saveData() &&
      !document.hidden &&
      navigator.onLine &&
      Boolean(navigator.serviceWorker?.controller),
    sync: () => postOfflineSync(unreadSourceIds(tree())),
    wanted: () => signedIn() && offlineUnread.get(),
  });
  createEffect(
    () => [tree(), signedIn(), offlineUnread.get()],
    () => untrack(() => pacer.request()),
  );
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
