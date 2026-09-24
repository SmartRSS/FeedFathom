# 0007 — One per-host clock, 1 second for interactive and 10 for background

- **Status:** accepted
- **Date:** 2026-09-24

## Context

Every outbound fetch took the same 10-second slot per hostname, including the
fetches a person is waiting on. Adding a feed from a site asks that site for
the page, then for each candidate feed, then for the preview, and then subscribe
probes it for WebSub. Many feeds send an ETag and no freshness, so the cache
cannot answer and every step made a request. Measured against Redis, each step
after the first waited 10.0 seconds, which is about 30 seconds for one feed.
A second same-host candidate in `/api/find` ran out of its reservation window
and came back without its WebSub mark.

## Decision

All requests to a host share one clock, `http-last-request:${hostname}`. It
holds the Redis `TIME` of the last request of either priority and is updated by
a Lua script, so every instance reads the same clock.

- **Background** needs 10 seconds since the last request of either kind. It
  defers straight away if the gap has not passed or an interactive caller is
  waiting.
- **Interactive** needs 1 second. It waits for its turn for as long as the
  request deadline allows.
- Explicit blocks (429, `Retry-After`, `RateLimit-*`) apply to both priorities
  unchanged. The HTTP cache is still checked before any reservation, and it is
  used as it is, with no extra reuse window.
- `/api/find` probes candidates one at a time so that a probe is never dropped.

A mix of the two priorities therefore never contacts a host more than once per
second. That limit does not change with the number of users or accounts.

`find`, `preview` and `subscribe` also share a per-user allowance of 30
outbound-fetch requests a minute (`src/features/auth/outbound-fetch-budget.ts`).
The allowance limits how many hosts one account can reach. The per-host clock
limits how often any one host is contacted.

## Alternatives considered

**Interactive requests skip the interval.** Rejected, because politeness to a
host is not negotiable. A user could send `/api/find` at many pages of one
target host. Each page is a cache miss, so without a wait the server becomes a
free crawler of that host.

**Keep 10 seconds and add a short reuse window for uncacheable responses.**
Rejected. It fixes preview and subscribe but not the find probes, which go to
different URLs. It also stores responses the origin did not ask to be stored.

**A separate interactive slot beside the background one.** Rejected. Two
independent slots allow one request of each kind inside the same second. A
single clock is both simpler and stricter.

## Consequences

- Adding a feed from one site takes about 1 second per step instead of 10.
- A host that a person is actively browsing through FeedFathom can receive up
  to one request a second. This is about the rate of one browser tab, and it
  lasts only while someone is waiting.
- The worker still waits 10 seconds, and it backs off while an interactive
  caller is queued. Background polling never gets faster because of the
  shorter interactive gap.
