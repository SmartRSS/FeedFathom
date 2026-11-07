import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { TreeNode } from "#shared/contracts/responses.ts";
import { totalUnread } from "./feed-tree.ts";
import { browserTimers, type Timers } from "./timers.ts";

// The background new-article signal (#717). The tree already carries every
// source's unread count, so a rise in the total is the whole signal, and the
// open article list is never changed mid-read: a toast asks instead. A poll
// backs off from 30s to a 5-minute ceiling and resets when the user
// refreshes, and a hidden tab skips its cycles.
//
// The push stream (#991) announces article writes for this user's sources,
// and the answer is the same poll, so the toast and unread logic stay in one
// place. EventSource reconnects on its own; a stream that drops or never
// opens (a buffering proxy, a 401) leaves the poll on its backoff.

const firstPollDelayMs = 30_000;
const maxPollDelayMs = 5 * 60_000;
// Stream signals this close together share one tree load.
const streamSignalDelayMs = 2000;

export function nextPollDelayMs(
  completedCycles: number,
  streamOpen = false,
): number {
  if (streamOpen) return maxPollDelayMs;
  return Math.min(
    maxPollDelayMs,
    firstPollDelayMs * 2 ** Math.max(0, completedCycles),
  );
}

type NewArticleSignalOptions = {
  enabled(): boolean;
  hidden(): boolean;
  loadTree(): Promise<TreeNode[]>;
  // A failed poll stays silent apart from this: the next cycle retries.
  onPollFailure(cause: unknown): void;
  timers?: Timers;
};

export class NewArticleSignal {
  readonly #options: NewArticleSignalOptions;
  readonly #timers: Timers;
  readonly #count = createSignal(0);
  #disposed = false;
  #pollTimer: unknown;
  #pollCycles = 0;
  #pollDueAt = 0;
  #baseline: number | undefined;
  #streamOpen = false;
  #streamSignalTimer: unknown;
  // One poll at a time: a tree load aborts the one before it, so signals
  // arriving faster than the tree loads would never let one finish. A signal
  // during a poll waits for it, then gets one follow-up.
  #polling = false;
  #signalDuringPoll = false;

  constructor(options: NewArticleSignalOptions) {
    this.#options = options;
    this.#timers = options.timers ?? browserTimers;
  }

  /** Articles that arrived since the user last refreshed; zero hides the toast. */
  readonly arrived: Accessor<number> = () => this.#count[0]();

  /** The first tree is the baseline; polling starts from it. */
  start(tree: TreeNode[]): void {
    this.#baseline = totalUnread(tree);
    this.#schedule();
  }

  /** What the user asked for: the toast clears and the backoff starts over. */
  async refresh(): Promise<TreeNode[]> {
    this.#count[1](0);
    this.#pollCycles = 0;
    const tree = await this.#options.loadTree();
    this.#baseline = totalUnread(tree);
    return tree;
  }

  streamOpened(): void {
    this.#streamOpen = true;
  }

  streamFailed(): void {
    if (!this.#streamOpen) return;
    this.#streamOpen = false;
    this.#pollCycles = 0;
    // Only ever pulls the poll closer: a proxy that accepts the stream and
    // drops it every reconnect must not keep pushing the poll back.
    if (this.#timers.now() + nextPollDelayMs(0) < this.#pollDueAt)
      this.#schedule();
  }

  streamClosed(): void {
    this.#streamOpen = false;
    this.#timers.clear(this.#streamSignalTimer);
    this.#streamSignalTimer = undefined;
  }

  streamSignal(): void {
    if (this.#polling) {
      this.#signalDuringPoll = true;
      return;
    }
    if (this.#streamSignalTimer !== undefined) return;
    this.#streamSignalTimer = this.#timers.set(() => {
      this.#streamSignalTimer = undefined;
      if (this.#disposed || this.#options.hidden()) return;
      if (this.#polling) this.#signalDuringPoll = true;
      else void this.#poll();
    }, streamSignalDelayMs);
  }

  dispose(): void {
    this.#disposed = true;
    this.#timers.clear(this.#pollTimer);
    this.streamClosed();
    this.#count[1](0);
  }

  #schedule(): void {
    // A stream signal can run a poll while the timer is pending; one timer.
    this.#timers.clear(this.#pollTimer);
    if (this.#disposed || !this.#options.enabled()) return;
    const delay = nextPollDelayMs(this.#pollCycles, this.#streamOpen);
    this.#pollDueAt = this.#timers.now() + delay;
    this.#pollTimer = this.#timers.set(() => {
      if (this.#options.hidden()) this.#schedule();
      else void this.#poll();
    }, delay);
  }

  async #poll(): Promise<void> {
    // A timer firing mid-poll yields; the running poll reschedules it.
    if (this.#polling) return;
    this.#polling = true;
    try {
      const total = totalUnread(await this.#options.loadTree());
      if (this.#disposed) return;
      const baseline = this.#baseline;
      if (baseline !== undefined && total > baseline)
        this.#count[1]((count) => Math.max(count, total - baseline));
      this.#baseline = total;
    } catch (cause) {
      this.#options.onPollFailure(cause);
    } finally {
      this.#polling = false;
      this.#pollCycles += 1;
      this.#schedule();
      if (this.#signalDuringPoll) {
        this.#signalDuringPoll = false;
        this.streamSignal();
      }
    }
  }
}

/** The signal, with its stream open while `listening()` holds. */
export function createNewArticleSignal(
  options: NewArticleSignalOptions & { listening(): boolean },
): NewArticleSignal {
  const signal = new NewArticleSignal(options);
  createEffect(() => {
    if (!options.listening()) return;
    const stream = new EventSource("/api/events");
    stream.addEventListener("open", () => signal.streamOpened());
    stream.addEventListener("error", () => signal.streamFailed());
    stream.addEventListener("message", () => signal.streamSignal());
    onCleanup(() => {
      stream.close();
      signal.streamClosed();
    });
  });
  onCleanup(() => signal.dispose());
  return signal;
}
