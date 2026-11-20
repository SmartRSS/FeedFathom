export function isSnoozed(
  pausedUntil: Date | string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (pausedUntil === null || pausedUntil === undefined) return false;
  return new Date(pausedUntil).getTime() > now;
}
