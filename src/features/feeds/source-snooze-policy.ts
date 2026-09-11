/**
 * Per-source snooze (#725): a per-user, per-source `pausedUntil` timestamp
 * and nothing else. Parsing and saving continue unchanged during the pause;
 * snooze is a display-level suppression only, evaluated lazily at read time,
 * so expiry needs no cleanup pass or scheduled job -- the moment the
 * timestamp passes, the source reappears with its full backlog waiting
 * unread. A null (or past) timestamp means not snoozed, which is also how
 * un-pausing early is represented.
 */
export function isSnoozed(
  pausedUntil: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return (
    pausedUntil !== null &&
    pausedUntil !== undefined &&
    pausedUntil.getTime() > now.getTime()
  );
}
