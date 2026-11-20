import { HttpDeadlineError } from "./request-deadline.ts";

export class HttpDeferredError extends Error {
  constructor(readonly retryAt: number) {
    super(`Request deferred until ${new Date(retryAt).toISOString()}`);
  }
}

export class HttpPacedError extends HttpDeferredError {}

export const isNoAnswerError = (error: unknown) =>
  error instanceof HttpDeferredError || error instanceof HttpDeadlineError;
