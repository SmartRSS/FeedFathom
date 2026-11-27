export class HttpDeadlineError extends Error {
  constructor(readonly milliseconds: number) {
    super(`HTTP request exceeded its ${milliseconds} ms deadline`);
  }
}

export class RequestDeadline {
  readonly controller = new AbortController();
  readonly endsAt: number;
  private readonly expired: Promise<never>;
  private readonly milliseconds: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly cancelled: AbortSignal | undefined;
  private readonly cancel = () => {
    this.controller.abort(this.cancelled?.reason);
  };

  constructor(milliseconds: number, cancelled?: AbortSignal) {
    this.milliseconds = milliseconds;
    this.endsAt = Date.now() + milliseconds;
    this.cancelled = cancelled;
    this.expired = new Promise((_, reject) => {
      this.controller.signal.addEventListener(
        "abort",
        () => {
          reject(this.controller.signal.reason);
        },
        { once: true },
      );
      this.timer = setTimeout(() => {
        this.controller.abort(new HttpDeadlineError(this.milliseconds));
      }, milliseconds);
    });
    this.expired.catch(() => undefined);
    if (cancelled?.aborted) this.cancel();
    else cancelled?.addEventListener("abort", this.cancel, { once: true });
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
    if (!this.controller.signal.aborted && Date.now() >= this.endsAt)
      this.controller.abort(new HttpDeadlineError(this.milliseconds));
    this.controller.signal.throwIfAborted();
  }

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
    this.cancelled?.removeEventListener("abort", this.cancel);
  }
}
