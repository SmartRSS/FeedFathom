// What a hub is assumed to have granted when it verifies a subscription
// without naming a lease, or names one that makes no sense.
export const defaultLeaseSeconds = 24 * 60 * 60;

/**
 * How long a verified WebSub subscription lasts.
 *
 * The value arrives from the hub as a query parameter, so it is whatever the
 * hub chose to send: absent, empty, non-numeric, negative, or Infinity. Only a
 * finite positive number is honoured; everything else falls back to the
 * default rather than producing a lease that has already expired or never
 * expires.
 */
export function resolveLeaseSeconds(requested: string | undefined): number {
  const parsed = Number(requested);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultLeaseSeconds;
}

export function leaseExpiresAt(leaseSeconds: number, now: number): Date {
  return new Date(now + leaseSeconds * 1_000);
}
