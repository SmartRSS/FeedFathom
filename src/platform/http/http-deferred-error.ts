// Raised when a request cannot proceed right now but is expected to succeed
// later: the origin is rate limited, or this instance's own politeness
// interval for the host has not elapsed. Distinct from a failure -- the caller
// is meant to come back, not to give up.
export class HttpDeferredError extends Error {
  constructor(readonly retryAt: number) {
    super(`Request deferred until ${new Date(retryAt).toISOString()}`);
  }
}
