# 0003 — A cache hit is skipped only on an explicit signal

- **Status:** accepted
- **Date:** 2026-09-05

## Context

One of the outbound-fetch requirements is "never make a request to a resource
we have a valid cache for". Everything honoured it except one flag.

`HttpRequestOptions.skipCache` bypasses the local freshness short-circuit in
`HttpClient.getWhileCacheLocked`. The request still goes out conditionally, so
an unchanged origin answers 304 and no body is transferred — but a request is
made against an entry still inside its `max-age`. Two callers set it: a manual
refresh, and a WebSub push.

The two are not the same case, and that is what made the flag look like one
exception when it was really two.

## Decision

Split them.

**A WebSub push no longer makes a request at all.** The hub POSTs the feed
document to the callback and signs it with the secret we handed that hub, so
the content is already in hand and already authenticated. The callback route
seeds the HTTP cache with the pushed body (`HttpClient.seedCache`) and queues
the ordinary parse against it. Nothing goes out, and the stored entry ends up
holding the new document rather than the one the push replaced. A hub that
sends a thin ping — a notification with no body — still falls back to a fetch,
because there is nothing to seed.

**A manual refresh keeps `skipCache`, and the requirement is amended to admit
it:**

> Never make a request to a resource we have a valid cache for, except on an
> explicit user action.

A person pressing refresh is asking us to go and look. Serving them the cache
because the entry has 200 seconds left is the button not working, and the cost
of honouring it is one conditional request that usually comes back 304.

## Alternatives considered

**Drop `skipCache` entirely.** The strict reading. Rejected while WebSub still
used it: a fresh cache entry would hide a push for up to `max-age`, which
defeats the point of subscribing to a hub. Now that a push carries its own
body, the only remaining caller is manual refresh, where the flag is the
feature rather than the leak.

**Keep `skipCache` for both and amend the requirement once**, which is where
this started. Rejected on measurement rather than principle: consuming the push
body removes a whole class of requests, so writing the WebSub case down as a
permitted exception would have preserved a request that did not need to exist.

**Parse the pushed body directly into the article upsert**, bypassing the cache
and the HTTP client. Rejected: it is a second ingest path with its own copy of
the parsing, dedup and article-mapping decisions, and it leaves the cached
entry stale, so the next poll reads the document the push replaced. Seeding the
cache reaches the same place through the pipeline that already exists.

## Consequences

- A WebSub push with a body costs zero outbound requests. Before, it cost one
  conditional GET per push against an entry that was usually still fresh.
- The seeded entry carries no `ETag` or `Last-Modified`, because the origin's
  validator for that state is unknown. The next revalidation after a push goes
  out unconditional — one full response later, against one saved now.
- The seeded entry is fresh for five minutes. Past that the parse fetches
  normally, so a backlogged worker degrades into the old behaviour instead of
  reading a body no origin ever confirmed.
- A body too large for the cache is refused by `saveCached`, which deletes the
  stale entry. The parse then fetches. The failure direction is always "make
  the request", never "serve something wrong".
