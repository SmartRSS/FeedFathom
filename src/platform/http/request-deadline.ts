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
  constructor() {
    super("HTTP request exceeded its 30 second deadline");
  }
}

export class RequestDeadline {
  readonly controller = new AbortController();
  private readonly endsAt: number;
  private readonly expired: Promise<never>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(milliseconds: number) {
    this.endsAt = Date.now() + milliseconds;
    this.expired = new Promise((_, reject) => {
      this.timer = setTimeout(() => {
        const error = new HttpDeadlineError();
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
      const error = new HttpDeadlineError();
      if (!this.controller.signal.aborted) this.controller.abort(error);
      throw error;
    }
  }

  async sleep(milliseconds: number): Promise<void> {
    await this.run(
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    );
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
