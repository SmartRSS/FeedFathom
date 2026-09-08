# 0005 — Sessions expire absolutely and are revocable per session

- **Status:** accepted
- **Date:** 2026-09-08

## Context

The `sessions` table held `id`, `sid`, `user_agent`, `user_id` and nothing
else: a session was valid until its row was deleted by hand. The cookie
carried `Max-Age=365d`, so a legitimate client re-sent the sid for a year,
and a stolen `sid` was equally valid for as long as the row existed. There
was no "sign out my other devices", and nothing an individual session could
be revoked with (#695).

## Decision

- **Absolute expiry, matching the cookie.** Each session row carries
  `created_at` and `expires_at`, defaulting to creation + 365 days
  (`SESSION_TTL_DAYS`). The window is absolute, not sliding: renewal on
  activity would keep a stolen sid alive forever on an account whose owner
  never logs out, and sliding renewal is a behavior the issue's threat
  model does not buy back. 365 days was chosen because the cookie already
  promised it — the server now keeps the same promise it always made, so
  no legitimate client observes a change.
- **Enforcement at the lookup, not at the edges.** `getUserBySid` rejects
  expired rows. It is the one choke point every request's session flows
  through (both the auth plugin and `GET /api/session`), so no route can
  forget the check and no second description of "valid" can drift from the
  first.
- **Purge, not enforcement, in the cleanup pass.** `cleanupOrphanedData`
  deletes expired rows. Expired rows are unreachable weight; the pass is
  housekeeping only, so a stuck worker cannot extend a session's life.
- **Revocation is per session and per account.** The options page lists the
  account's sessions with the requesting one flagged, revokes individual
  sessions, and revokes all others at once. Every service method scopes by
  user id, so a guessed or forged session id can only ever land on the
  caller's own rows. The current session deliberately has no revoke
  endpoint: `POST /api/logout` already signs it out and clears the cookie,
  and a second path to the same effect is one more thing to keep honest.

## Consequences

- A stolen sid is now bounded by the same 365 days as the cookie (previously:
  unbounded), and by revocation from the account's other sessions
  (previously: nothing).
- Existing sessions at migration time gain `expires_at` = migration date +
  365 days — everyone gets a fresh full window once, which is the benign
  direction for a "nothing expires" deployment.
- Login, logout, and registration needed no changes: they already create
  and delete whole rows.
