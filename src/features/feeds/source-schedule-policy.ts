// A floor on how soon a feed may be polled again, regardless of what the
// caller -- or the origin's own Cache-Control -- asks for. An origin sending
// no-cache/max-age=0 must not be able to make a periodic poller hammer it
// every gather cycle.
export const pollFloorMs = 5 * 60_000;

// A failing source waits one more floor per consecutive failure, up to this
// many.
export const failureBackoffMaxSteps = 15;

// How often a source with a verified WebSub subscription is polled anyway, as
// a safety net for a push the hub dropped.
export const webSubFallbackPollMs = 24 * 60 * 60_000;

/**
 * The earliest a source may next be fetched: the requested time, or the poll
 * floor, whichever is later. With no request, the poll floor.
 *
 * Only matters for "feed" kind in practice -- getSourcesToProcess ignores
 * notBefore for "websub" and "email" -- but it is applied unconditionally
 * because the caller recording a success does not know the kind.
 */
export function clampToPollFloor(
  requested: Date | undefined,
  now: number,
): Date {
  return new Date(Math.max(requested?.getTime() ?? 0, now + pollFloorMs));
}
