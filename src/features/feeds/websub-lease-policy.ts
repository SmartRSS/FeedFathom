import type { WebSubStatus } from "#platform/db/schemas/sources.ts";

const defaultLeaseSeconds = 24 * 60 * 60;

export function resolveLeaseSeconds(requested: string | undefined): number {
  const parsed = Number(requested);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultLeaseSeconds;
}

export function shouldAttemptWebSubSubscribe(
  status: undefined | WebSubStatus,
): boolean {
  return status === undefined || status === "none" || status === "pending";
}
