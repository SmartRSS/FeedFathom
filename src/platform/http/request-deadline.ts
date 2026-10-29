/**
 * A wall-clock budget shared by every step of one HTTP request -- the fetch,
 * each retry, each redirect hop, and the sleeps between them.
 *
 * It exists because a per-attempt timeout does not bound a request that keeps
 * making progress: five retries each finishing just under their own limit, or
 * a redirect chain that never stalls, can run far past what the caller was
 * willing to wait. One deadline for the whole operation does bound it.
 *
 * The AbortController is exposed so the transport can be cancelled the moment
 * the budget runs out rather than after its current read returns.
 */
export class HttpDeadlineError extends Error {
  constructor(milliseconds: number) {
    super(`HTTP request exceeded its ${milliseconds} ms deadline`);
  }
}

export class RequestDeadline {
  readonly controller = new AbortController();
  // Exposed so a caller that has to wait for something else (a rate-limit
  // slot, a host's block window) can tell whether the wait fits in the
  // budget instead of guessing at a window of its own.
  readonly endsAt: number;
  private readonly expired: Promise<never>;
  private readonly milliseconds: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(milliseconds: number) {
    this.milliseconds = milliseconds;
    this.endsAt = Date.now() + milliseconds;
    this.expired = new Promise((_, reject) => {
      this.timer = setTimeout(() => {
        const error = new HttpDeadlineError(this.milliseconds);
        this.controller.abort(error);
        reject(error);
      }, milliseconds);
    });
  }

  async run<T>(operation: Promise<T>): Promise<T> {
    try {
      this.assertActive();
    } catch (error) {
      void operation.catch(() => undefined);
      throw error;
    }
    return Promise.race([operation, this.expired]);
  }

  assertActive(): void {
    if (Date.now() >= this.endsAt || this.controller.signal.aborted) {
      const error = new HttpDeadlineError(this.milliseconds);
      if (!this.controller.signal.aborted) this.controller.abort(error);
      throw error;
    }
  }

  // Clears its own timer, so a sleep cut short by the deadline does not keep
  // a timer alive past the request.
  async sleep(milliseconds: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.run(
        new Promise((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
