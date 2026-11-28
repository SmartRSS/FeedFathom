import { browserTimers, type Timers } from "./timers.ts";

type WaitEntry = {
  onSettled: () => void;
  timer: unknown;
};

export class SourceRefreshWaiter {
  readonly #timers: Timers;
  readonly #pending = new Map<number, Set<WaitEntry>>();
  #disposed = false;

  constructor(timers: Timers = browserTimers) {
    this.#timers = timers;
  }

  wait(
    sourceId: number,
    fallbackMs: number,
    onSettled: () => void,
  ): () => void {
    if (this.#disposed) return () => {};
    const entry: WaitEntry = {
      onSettled,
      timer: undefined,
    };
    let bucket = this.#pending.get(sourceId);
    if (!bucket) {
      bucket = new Set();
      this.#pending.set(sourceId, bucket);
    }
    bucket.add(entry);
    const cancel = () => {
      if (!bucket.delete(entry)) return;
      this.#timers.clear(entry.timer);
      if (bucket.size === 0) this.#pending.delete(sourceId);
    };
    entry.timer = this.#timers.set(() => {
      cancel();
      if (!this.#disposed) onSettled();
    }, fallbackMs);
    return cancel;
  }

  notify(sourceId: number): void {
    if (this.#disposed) return;
    const bucket = this.#pending.get(sourceId);
    if (!bucket) return;
    this.#pending.delete(sourceId);
    for (const entry of bucket) {
      this.#timers.clear(entry.timer);
      entry.onSettled();
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const bucket of this.#pending.values()) {
      for (const entry of bucket) this.#timers.clear(entry.timer);
    }
    this.#pending.clear();
  }
}
