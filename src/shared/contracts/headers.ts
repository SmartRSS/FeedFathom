// Request headers the SPA and its service worker send for the server to log
// with an article delete.

// The event that triggered the delete and the input just before it.
export const deleteTraceHeader = "X-FeedFathom-Trace";
// When a delete queued offline was first made, on its replay.
export const replayHeader = "X-FeedFathom-Replay";
