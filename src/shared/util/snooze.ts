/**
 * Per-source snooze (#725): a per-user, per-source `pausedUntil` timestamp
 * and nothing else. Parsing and saving continue unchanged during the pause;
 * snooze is a display-level suppression only, evaluated lazily at read time,
 * so expiry needs no cleanup pass or scheduled job -- the moment the
 * timestamp passes, the source reappears with its full backlog waiting
 * unread. A missing, past or unparseable timestamp means not snoozed, which
 * is also how un-pausing early is represented.
 */
export function isSnoozed(
  pausedUntil: Date | string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (pausedUntil === null || pausedUntil === undefined) return false;
  return new Date(pausedUntil).getTime() > now;
}
