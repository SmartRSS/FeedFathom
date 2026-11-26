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
