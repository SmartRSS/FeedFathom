import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { TreeNode } from "#shared/contracts/responses.ts";
import { totalUnread } from "./feed-tree.ts";
import { browserTimers, type Timers } from "./timers.ts";

const firstPollDelayMs = 30_000;
const maxPollDelayMs = 5 * 60_000;
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
  #polling = false;
  #signalDuringPoll = false;

  constructor(options: NewArticleSignalOptions) {
    this.#options = options;
    this.#timers = options.timers ?? browserTimers;
  }

  readonly arrived: Accessor<number> = () => this.#count[0]();

  start(tree: TreeNode[]): void {
    this.#baseline = totalUnread(tree);
    this.#schedule();
  }

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

export type StreamArticleEvent = { count: number; sourceId: number };

export function parseStreamArticleEvent(
  data: unknown,
): StreamArticleEvent | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(data);
    if (
      typeof value === "object" &&
      value !== null &&
      "sourceId" in value &&
      "count" in value &&
      Number.isSafeInteger(value.sourceId) &&
      Number.isSafeInteger(value.count)
    ) {
      return { count: Number(value.count), sourceId: Number(value.sourceId) };
    }
  } catch {}
  return undefined;
}

export function createNewArticleSignal(
  options: NewArticleSignalOptions & {
    listening(): boolean;
    onSourceEvent?: (event: StreamArticleEvent) => void;
  },
): NewArticleSignal {
  const signal = new NewArticleSignal(options);
  createEffect(
    () => options.listening(),
    (listening) => {
      if (!listening) return undefined;
      const stream = new EventSource("/api/events");
      stream.addEventListener("open", () => signal.streamOpened());
      stream.addEventListener("error", () => signal.streamFailed());
      stream.addEventListener("message", (message) => {
        const event = parseStreamArticleEvent(message.data);
        if (!event) return;
        if (event.count > 0) signal.streamSignal();
        options.onSourceEvent?.(event);
      });
      return () => {
        stream.close();
        signal.streamClosed();
      };
    },
  );
  onCleanup(() => signal.dispose());
  return signal;
}
