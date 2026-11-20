export const pollFloorMs = 5 * 60_000;

export const failureBackoffMaxSteps = 15;

export const webSubFallbackPollMs = 24 * 60 * 60_000;

export function clampToPollFloor(
  requested: Date | undefined,
  now: number,
): Date {
  return new Date(Math.max(requested?.getTime() ?? 0, now + pollFloorMs));
}
