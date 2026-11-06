import { HttpDeadlineError } from "./request-deadline.ts";

// Raised when a request cannot proceed right now but is expected to succeed
// later: the origin is rate limited, or this instance's own politeness
// interval for the host has not elapsed. Distinct from a failure -- the caller
// is meant to come back, not to give up.
export class HttpDeferredError extends Error {
  constructor(readonly retryAt: number) {
    super(`Request deferred until ${new Date(retryAt).toISOString()}`);
  }
}

// The limiter's own politeness interval, as opposed to a block the origin
// asked for: it always clears within one interval, whatever the origin says.
export class HttpPacedError extends HttpDeferredError {}

// A deferral and our own expired deadline both mean "we never got an answer",
// which the error hook maps to a 429 and a 504. A caller that classifies fetch
// failures re-raises these rather than blaming the URL it fetched.
export const isNoAnswerError = (error: unknown) =>
  error instanceof HttpDeferredError || error instanceof HttpDeadlineError;
