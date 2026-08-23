// A floor on how soon a feed may be polled again, regardless of what the
// caller -- or the origin's own Cache-Control -- asks for. An origin sending
// no-cache/max-age=0 must not be able to make a periodic poller hammer it
// every gather cycle.
export const pollFloorMs = 5 * 60_000;

/**
 * The earliest a source may next be fetched: the requested time, or the poll
 * floor, whichever is later.
 *
 * Only matters for "feed" kind in practice -- getSourcesToProcess ignores
 * notBefore for "websub" and "email" -- but it is applied unconditionally
 * because the caller recording a success does not know the kind.
 */
export function clampToPollFloor(requested: Date, now: number): Date {
  return new Date(Math.max(requested.getTime(), now + pollFloorMs));
}
