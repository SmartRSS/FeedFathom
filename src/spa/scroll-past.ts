// The mark-read-on-scroll-past queue (#714). Pure bookkeeping: which row ids
// have dwelled in the viewport long enough to count as "scrolled past", and
// how they batch into one request. The IntersectionObserver that feeds it and
// the request it flushes into live in dashboard.tsx; this module stays free of
// both so the dwell/batch rules can be tested against a fake clock.

export type ScrollPastQueueOptions = {
  /** Called with a nonempty, ordered, deduplicated id list. */
  flush: (ids: number[]) => void;
  /** How long a row must stay ≥50% visible before it counts as read. */
  dwellMs?: number;
  /** Minimum spacing between flushes, so a long scroll makes one request. */
  flushEveryMs?: number;
  /** Flush immediately once this many ids are waiting. */
  cap?: number;
  /** Injectable clock/timers, so tests never sleep. */
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
};

const SECOND = 1000;
// The dwell and the flush spacing agree at about a second: long enough that
// a row flashed past while jumping around is not marked, short enough that a
// steady scroll never queues more than a request's worth of rows.
const DEFAULT_DWELL_MS = SECOND;
const DEFAULT_FLUSH_EVERY_MS = SECOND;
const DEFAULT_CAP = 25;

export class ScrollPastQueue {
  readonly #dwellMs: number;
  readonly #flushEveryMs: number;
  readonly #cap: number;
  readonly #flush: (ids: number[]) => void;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, ms: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  // id -> the time it became (re)visible. Leaving the viewport cancels, so a
  // row flashed past on the way down starts its dwell over on the way back.
  #dwelling = new Map<number, number>();
  // Dwell completed, waiting to ride the next flush.
  #pending: number[] = [];
  // When the current batch got its first row, so the batch can stay open for
  // rows still mid-dwell without a long scroll holding it open forever.
  #pendingSince: number | undefined;
  #handle: unknown;
  // -Infinity so the first batch with anything pending flushes immediately;
  // the throttle only spaces out the flushes after that.
  #lastFlushAt = Number.NEGATIVE_INFINITY;

  constructor(options: ScrollPastQueueOptions) {
    this.#dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
    this.#flushEveryMs = options.flushEveryMs ?? DEFAULT_FLUSH_EVERY_MS;
    this.#cap = options.cap ?? DEFAULT_CAP;
    this.#flush = options.flush;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    // `unknown` handles keep the injectable seam honest (the queue never
    // inspects what schedule returned); the default hands it straight back
    // to the platform's clearTimeout.
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as number | undefined));
  }

  /** A row entered the viewport (≥50% visible). */
  add(id: number) {
    // Already dwelled or dwelling: keep the original visibility time rather
    // than restarting the dwell on every observer tick.
    if (this.#pending.includes(id) || this.#dwelling.has(id)) return;
    this.#dwelling.set(id, this.#now());
    this.#arm();
  }

  /** A row left the viewport (or became ineligible): forget its dwell. */
  cancel(id: number) {
    if (!this.#dwelling.delete(id)) return;
    this.#arm();
  }

  /** Everything waiting goes out now, in one batch. */
  flushNow() {
    this.#disarm();
    if (!this.#pending.length) return;
    const ids = this.#pending;
    this.#pending = [];
    this.#pendingSince = undefined;
    this.#lastFlushAt = this.#now();
    this.#flush(ids);
    this.#arm();
  }

  /** Drop everything without flushing; the observer is going away. */
  dispose() {
    this.#disarm();
    this.#dwelling.clear();
    this.#pending = [];
    this.#pendingSince = undefined;
  }

  #disarm() {
    if (this.#handle === undefined) return;
    this.#cancelScheduled(this.#handle);
    this.#handle = undefined;
  }

  #arm() {
    this.#disarm();
    const delay = this.#nextDelay();
    if (delay === undefined) return;
    this.#handle = this.#schedule(() => this.#onTimer(), delay);
  }

  /** The time the current batch may go out, or undefined with nothing
   *  pending. Two constraints, and the later one wins:
   *
   *  - Spacing. Never sooner than one window after the last flush, which is
   *    what keeps a long scroll to one request per window.
   *  - Filling. While any row is still mid-dwell it belongs to the same
   *    gesture as the rows already pending, so the batch stays open for it --
   *    but only for one window, or a scroll that never stops would hold the
   *    batch open forever. With nothing dwelling there is nobody left to wait
   *    for and this constraint drops out.
   *
   *  Without the filling half, two rows whose dwells complete a millisecond
   *  apart leave as two requests: the timer fires on the first completion,
   *  finds the batch nonempty and the spacing satisfied, and goes. That is
   *  the ordinary case, not an edge one -- rows enter the viewport as the
   *  scroll carries them, never in lockstep. */
  #readyAt(): number | undefined {
    if (this.#pendingSince === undefined) return undefined;
    const spacing = this.#lastFlushAt + this.#flushEveryMs;
    // 0 rather than -Infinity: times here are non-negative, so it reads as
    // "no constraint" against any real clock while staying a number.
    const filling = this.#dwelling.size
      ? this.#pendingSince + this.#flushEveryMs
      : 0;
    return Math.max(spacing, filling);
  }

  /** When the next deadline falls: the earliest dwell completion, or the
   *  moment the pending batch is allowed out -- whichever is sooner.
   *  Undefined when there is nothing to wait for. */
  #nextDelay(): number | undefined {
    const time = this.#now();
    let delay: number | undefined;
    for (const since of this.#dwelling.values()) {
      const remaining = Math.max(0, since + this.#dwellMs - time);
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
    const time = this.#now();
    for (const [id, since] of this.#dwelling) {
      if (time - since < this.#dwellMs) continue;
      this.#dwelling.delete(id);
      if (!this.#pending.includes(id)) this.#pending.push(id);
      this.#pendingSince ??= time;
    }
    if (this.#pending.length >= this.#cap) {
      this.flushNow();
      return;
    }
    // The deadline can fall on the same tick a dwell completes; flush on that
    // tick rather than scheduling a zero-delay timer.
    const readyAt = this.#readyAt();
    if (readyAt !== undefined && this.#now() >= readyAt) {
      this.flushNow();
      return;
    }
    this.#arm();
  }
}
