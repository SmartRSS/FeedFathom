# 0002 — Rate-limit keys are per hostname, not per registrable domain

- **Status:** accepted
- **Date:** 2026-09-05
- **Amended:** 2026-09-24, pacing rule and key names ([#909](https://github.com/SmartRSS/FeedFathom/issues/909))

## Context

Outbound fetching is governed by three Redis keys, all in
`src/platform/http/http-rate-limiter.ts`:

```
http-last-request:${hostname}  when this deployment last sent the host a
                               request, of either priority
http-blocked:${hostname}       set when a host answers 429, or sends
                               Retry-After, or reports RateLimit-Remaining: 0
http-interactive:${hostname}   how many interactive callers are waiting
```

The requirement they answer is "never hammer a host". Every request is paced
against the one shared `http-last-request` clock: background work needs 10
seconds since the last request of any priority, and a person waiting on a
response needs 1 second. So a host sees at most one request a second from this
deployment, whatever the mix. An interactive request waits for its turn and
never skips it. Otherwise one account could make the server crawl a host by
pointing `/api/find` at page after page that is not in the cache.

What "domain" means was never written down, and the two readings differ. A
publisher spread across `a.example.com`, `b.example.com` and
`feeds.example.com` gets three independent buckets today, so one operator's
infrastructure can take three requests inside the interval. A 429 from one of
those subdomains also does not hold back the other two.

## Decision

Keep the keys on the hostname. "Domain" in the requirement is read as the host
we actually connect to.

## Alternatives considered

**Key on the registrable domain (eTLD+1).** The strict reading. Rejected on
cost: it needs a public suffix list to be correct, which is a dependency plus a
data file that goes stale, consulted on the hot path of every fetch. The naive
substitute — take the last two labels — is wrong for `.co.uk`, `.com.au` and
every other multi-label suffix, and without a real list `foo.github.io` and
`bar.github.io` collapse into one bucket. Sharing a bucket across unrelated
publishers is a worse failure than the one being fixed: it is invisible, and it
slows every feed on a shared host.

**Propagate only a `Retry-After` block up to the registrable domain**, keeping
per-hostname intervals. This looked like the cheap middle ground and is not:
knowing where to write the parent key still means computing eTLD+1, so it pays
most of the public suffix list's cost for a fraction of its effect.

## Consequences

- A publisher on several hostnames can be contacted once per hostname per
  second. Per-hostname is also what most feed readers do, and the more common
  shape by far is the opposite one — many unrelated publishers behind a single
  CDN hostname, which per-hostname keying already handles correctly.
- A 429 from one subdomain does not hold back its siblings. The individual
  hostname that answered is still blocked, and after
  [#674](https://github.com/SmartRSS/FeedFathom/issues/674) that is the
  hostname which actually answered rather than the one a redirect chain
  started at.
- If this is ever revisited, the trigger to watch for is an operator
  complaining about aggregate load rather than per-host load. That is the
  evidence this decision trades away, and nothing else about the design has to
  change to add a public suffix list behind `reserve()`.
