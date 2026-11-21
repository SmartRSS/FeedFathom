import { browserTimers, type Timers } from "./timers.ts";

type ScrollPastQueueOptions = {
  flush: (ids: number[]) => void;
  flushEveryMs?: number;
  cap?: number;
  timers?: Timers;
};

const SECOND = 1000;
const DWELL_MS = SECOND;
const DEFAULT_FLUSH_EVERY_MS = SECOND;
const DEFAULT_CAP = 25;

export class ScrollPastQueue {
  readonly #flushEveryMs: number;
  readonly #cap: number;
  readonly #flush: (ids: number[]) => void;
  readonly #timers: Timers;
  #dwelling = new Map<number, number>();
  #pending = new Set<number>();
  #pendingSince: number | undefined;
  #handle: unknown;
  #lastFlushAt = Number.NEGATIVE_INFINITY;

  constructor(options: ScrollPastQueueOptions) {
    this.#flushEveryMs = options.flushEveryMs ?? DEFAULT_FLUSH_EVERY_MS;
    this.#cap = options.cap ?? DEFAULT_CAP;
    this.#flush = options.flush;
    this.#timers = options.timers ?? browserTimers;
  }

  add(id: number) {
    if (this.#pending.has(id) || this.#dwelling.has(id)) return;
    this.#dwelling.set(id, this.#timers.now());
    this.#arm();
  }

  cancel(id: number) {
    if (!this.#dwelling.delete(id)) return;
    this.#arm();
  }

  flushNow() {
    this.#disarm();
    if (!this.#pending.size) return;
    const ids = [...this.#pending];
    this.#pending.clear();
    this.#pendingSince = undefined;
    this.#lastFlushAt = this.#timers.now();
    this.#flush(ids);
    this.#arm();
  }

  dispose() {
    this.#disarm();
    this.#dwelling.clear();
    this.#pending.clear();
    this.#pendingSince = undefined;
  }

  #disarm() {
    if (this.#handle === undefined) return;
    this.#timers.clear(this.#handle);
    this.#handle = undefined;
  }

  #arm() {
    this.#disarm();
    const delay = this.#nextDelay();
    if (delay === undefined) return;
    this.#handle = this.#timers.set(() => this.#onTimer(), delay);
  }

  #readyAt(): number | undefined {
    if (this.#pendingSince === undefined) return undefined;
    const spacing = this.#lastFlushAt + this.#flushEveryMs;
    const filling = this.#dwelling.size
      ? this.#pendingSince + this.#flushEveryMs
      : 0;
    return Math.max(spacing, filling);
  }

  #nextDelay(): number | undefined {
    const time = this.#timers.now();
    let delay: number | undefined;
    for (const since of this.#dwelling.values()) {
      const remaining = Math.max(0, since + DWELL_MS - time);
      if (delay === undefined || remaining < delay) delay = remaining;
    }
    const readyAt = this.#readyAt();
    if (readyAt !== undefined) {
      const due = Math.max(0, readyAt - time);
      if (delay === undefined || due < delay) delay = due;
    }
    return delay;
  }

  #onTimer() {
    this.#handle = undefined;
    const time = this.#timers.now();
    for (const [id, since] of this.#dwelling) {
      if (time - since < DWELL_MS) continue;
      this.#dwelling.delete(id);
      this.#pending.add(id);
      this.#pendingSince ??= time;
    }
    if (this.#pending.size >= this.#cap) {
      this.flushNow();
      return;
    }
    const readyAt = this.#readyAt();
    if (readyAt !== undefined && this.#timers.now() >= readyAt) {
      this.flushNow();
      return;
    }
    this.#arm();
  }
}

export function observeScrollPast(options: {
  eligible(id: number): boolean;
  flush(ids: number[]): void;
  list: HTMLElement;
  passiveFirstPass: boolean;
  rowId(row: Element): number | undefined;
}): () => void {
  const queue = new ScrollPastQueue({ flush: options.flush });
  let primed = !options.passiveFirstPass;
  const observer = new IntersectionObserver(
    (entries) => {
      const counting = primed;
      primed = true;
      for (const entry of entries) {
        const id = options.rowId(entry.target);
        if (id === undefined) continue;
        const dwelling =
          counting &&
          entry.isIntersecting &&
          entry.intersectionRatio >= 0.5 &&
          options.eligible(id);
        if (dwelling) queue.add(id);
        else queue.cancel(id);
      }
    },
    { root: options.list, threshold: [0.5] },
  );
  for (const row of options.list.querySelectorAll(".article[data-index]"))
    observer.observe(row);
  return () => {
    queue.flushNow();
    queue.dispose();
    observer.disconnect();
  };
}
