# 0007 — New-article signals go worker → Redis pub/sub → SSE

- **Status:** accepted
- **Date:** 2026-10-06

## Context

The dashboard learned about new articles only by polling `/api/tree`, backing
off from 30 seconds to 5 minutes (#717). An article could take five minutes to
show up, and every cycle reloaded the whole tree whether anything had changed
or not (#991).

The worker writes articles. The server holds the browser connections. The two
processes share PostgreSQL and Redis, and nothing else.

## Decision

**The worker publishes, the server forwards, and the browser polls on the
signal.**

- After a parse or an inbound newsletter writes articles and the unread
  counts have been recomputed, the writer publishes `{ sourceId, count }` on
  the Redis channel `feedfathom:article-events`. The publish never fails the
  write it announces.
- Each server process holds **one** subscriber connection
  (`ArticleEventHub`), opened on the first stream, and fans each message out
  in memory to the open `GET /api/events` streams. A stream forwards only
  sources its user subscribes to. It reads that set when the stream opens and
  re-reads it, along with the session, once a minute.
- The SPA opens an `EventSource` while the dashboard is mounted and background
  checking is on. A message runs the existing tree poll, coalesced over two
  seconds, so the toast and unread logic stay in one place. The timer poll
  stays as the fallback: at its 5-minute ceiling while the stream is open, and
  back on the 30-second backoff when the stream drops or never opens.

## Alternatives considered

**WebSockets.** Two-way, and nothing needs to flow from the browser. SSE is
plain HTTP, passes the session cookie without extra work, and the browser
reconnects on its own.

**A Redis connection per stream.** Simple, but it ties Redis connection count
to open tabs. One subscriber per process costs one connection, whatever the
number of streams.

**Push the changed tree or article rows in the event.** That builds a second
read path beside `/api/tree` that has to agree with it on visibility, snooze
and read state. A signal that triggers the existing read cannot disagree.

**Redis Streams instead of pub/sub.** Streams keep a backlog, so a server that
restarts could replay what it missed. The timer poll already covers a missed
signal, so delivery guarantees would buy nothing a user sees.

## Consequences

- A new article for a subscribed source reaches an open, visible dashboard
  within a few seconds. Hidden tabs ignore signals and keep to the timer.
- Each open dashboard holds one long-lived HTTP connection. Behind a proxy,
  response buffering must be off for `/api/events` (the response sends
  `X-Accel-Buffering: no` for nginx) and idle timeouts must exceed the
  25-second heartbeat. On HTTP/1.1 each stream uses one of the browser's six
  connections per origin, so serve the app over HTTP/2 where tabs pile up.
- A proxy that buffers or blocks the stream degrades the dashboard to the
  polling it had before, not to a broken page.
- Pub/sub ignores the Redis database number: every deployment sharing one
  Redis server shares the channel. Each stream filters by its user's source
  ids, so a stray event can trigger, at worst, one unneeded tree reload.
