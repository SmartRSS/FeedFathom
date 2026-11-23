export const deleteTraceHeader = "X-FeedFathom-Trace";
export const replayHeader = "X-FeedFathom-Replay";
export const unreadCountsHeader = "X-FeedFathom-Unread-Counts";
export const accountHeader = "X-FeedFathom-Account";
export const accountMismatchStatus = 412;

export function accountFromHeader(value: string | null): number | undefined {
  const account = Number(value);
  return Number.isSafeInteger(account) && String(account) === value
    ? account
    : undefined;
}
