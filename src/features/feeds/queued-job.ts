import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";

// Failures are recorded in PostgreSQL by whoever owns them, so BullMQ keeps
// no finished job: without this every run stays in Redis for good.
export const finishedJobRetention = {
  removeOnComplete: { count: 0 },
  removeOnFail: { count: 0 },
} as const;

/**
 * A deferral whose retry must run with different job data: what a deferred
 * job has learned so far, which the retry would otherwise start without.
 */
export class JobDeferral extends HttpDeferredError {
  constructor(
    retryAt: number,
    readonly data: object,
  ) {
    super(retryAt);
  }
}
