# 0009 — Auth: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Password reset and change

### A password reset is one statement that only one confirmation can win

**Where:** `src/features/auth/user-data-service.ts`, `UsersDataService.completePasswordReset()`; `src/features/auth/routes/password-reset.ts`, `createPasswordResetRoute()`

The new hash, the spent token and the deletion of every session commit together, so the link is single-use, whoever knew the old password is signed out by the same commit, and no crash can leave a working token or an old-password session behind. The token hash is in the UPDATE's WHERE clause, not only in the lookup before it, so two confirmations racing on one link serialise on the row lock and the second matches no row and is answered like an unknown token (#809). Checking the token in the route alone would let two passwords be written, the last one winning.

### A login cannot issue a session from a password that a reset just revoked

**Where:** `src/features/auth/user-data-service.ts`, `UsersDataService.createSession()`; `src/features/auth/routes/login.ts`, `createLoginRoute()`

A login verifies a hash it read earlier, and a reset may commit in between. `createSession` takes the verified hash and issues the session only while the row still holds it, under the row lock the reset's UPDATE takes: a login that locks first has its session deleted by the reset, and one that locks after gets no session (#843). The route answers a missing sid like a wrong password: no cookie, and the attempt stays counted.

### A password change writes only against the hash it verified

**Where:** `src/features/auth/user-data-service.ts`, `UsersDataService.updatePassword()`; `src/features/auth/routes/account.ts`, `createAccountRoutes()`

The change verifies the current password, hashes the replacement, then writes with the verified hash in the WHERE clause, so a reset that commits in between stays authoritative and the change is refused rather than reported as done (#977). The write deletes every session except the current one, so no old-password session outlives it while the caller stays signed in where they just typed the new password. Extends ADR 0005.

### Reset tokens are stored only as an unsalted SHA-256 digest

**Where:** `src/features/auth/account-tokens.ts`, `digestToken()`

The link carries the token and the users table only its digest, so a dump of the table is not a set of working links. A token from a link is digested the same way to look the account up, and only while the link is live. No salt or stretching is needed: the token is 122 random bits from `randomUUID`, so there is no dictionary to defend against.

### Password reset answers as for an unknown account when mail is off

**Where:** `src/features/auth/routes/password-reset.ts`, `createPasswordResetRoute()`

The reset routes are gated on outgoing mail like public registration; with no way to deliver a link there is no flow. The reset request gives one answer whether or not the account exists, mail is configured, or the request was throttled, because telling them apart would hand back the account list login withholds. Extends ADR 0004.

## Registration and activation

### The insert settles a same-address registration race and has the last word on open registration

**Where:** `src/features/auth/user-data-service.ts`, `UsersDataService.createUser()`; `src/features/auth/routes/register.ts`, `createRegisterRoute()`

The route's lookup cannot see an account committed after it, so the insert settles a race between two registrations of one address: one row with the winner's credentials and token, and every loser gets `"exists"`, the answer an existing account gets, and mails nothing (#848). The route's user count is not trusted either: two registrations on an empty instance with registration disabled both pass it, so the insert rechecks the policy under a table lock that admits exactly one first user, and answers `"closed"` when the policy refuses. The lock is taken only while no user exists, so it does not serialise every later registration.

### Registering an existing address answers generic success and acts by mail

**Where:** `src/features/auth/routes/register.ts`, `createRegisterRoute()`; `src/features/auth/mail-sender.ts`, `MailSender.sendAccountExistsEmail()`

An existing address gets the same success body as a new one (#810). With mail configured, an inactive account with a missing or expired activation link gets a fresh one, an active account gets an account-exists notice, and a valid activation link is left alone. The notice carries the ordinary password reset link, the way in that never assumes the password still works, and a scanner opening it finds a form, not a spent token.

### Activation mail is sent only for a committed token, and a failed send withdraws it

**Where:** `src/features/auth/routes/register.ts`, `sendActivation`; `src/features/auth/user-data-service.ts`, `UsersDataService.refreshActivationToken()`, `UsersDataService.withdrawActivationToken()`

Mail goes out only once the row holding its token is committed. When delivery fails the token is withdrawn, so the next registration attempt treats it as an expired link and sends a fresh one at once instead of after a day (#849). The refresh is a compare-and-set on expiry and on inactive status (an active account's path is the password reset, #810), so a second attempt while a delivered link is live stores and sends nothing, and of two racing recoveries only one stores its token. Withdrawal matches on the token itself, so it cannot clear a newer token another request already delivered.

### Opening an activation link activates nothing until the button is pressed

**Where:** `src/spa/account-flows.tsx`, `Activate`; `src/features/auth/routes/activate.ts`, `createActivateRoute()`

The activation page is a confirmation, not an action (#810), and only its button POSTs the token. A mail preview or link scanner that opens the link must leave the token as usable as it was for the person following it. `tests/browser/spa.spec.ts` covers this.

### Turnstile verification fails closed

**Where:** `src/features/auth/routes/register.ts`, `validateCaptcha()`

With mail configured, registration lets a stranger send mail from this instance's domain to an address they choose, and `ENABLE_REGISTRATION` and `ALLOWED_EMAILS` do not bound how many. Turnstile is the documented answer and the register throttle is the floor under a deployment without it. When verification itself errors, registration is refused, and the logged error tells an operator an outage from a wave of bad tokens. Extends ADR 0004.

### A failed mail is logged, never answered

**Where:** `src/features/auth/mail-sender.ts`, `sendLater()`

Registration and reset do not wait for their mail (ADR 0004), and the same reasoning covers failure: the route answers the success it would have answered anyway, because a 500 for a known address and not an unknown one would say which addresses hold accounts. `onFailure` undoes what the mail was for, such as withdrawing an activation token. Extends ADR 0004.

## Sessions

### The session derive is plugin-scoped and carries the admin check inside it

**Where:** `src/features/auth/session-plugin.ts`, `sessionPlugin()`, `createAdminPlugin()`

An Elysia `derive` with `"plugin"` scope reaches the instance's own routes and the one parent that `.use()`s it, not the sibling groups `server-app.ts` composes; a wider scope would put the session check on routes that must stay public. The admin test runs inside the same derive, because a plugin-scoped derive reaches routes but not later hooks on the same instance, so a second derive would find no `user`.

### A request that names another account is refused before its handler runs

**Where:** `src/features/auth/session-plugin.ts`, `sessionPlugin()`; `src/shared/contracts/headers.ts`, `accountHeader`

The session cookie is HttpOnly and a sign-in in another tab replaces it, so neither a page nor the service worker can know which account the browser will send a request as. Only the server sees the cookie and the request together. A request may name the account it was made for in `X-FeedFathom-Account`, and the session derive answers 412 when the session belongs to any other account. A request without the header passes, so pages and workers built before the header keep working. A client that relies on this check instead of its own, as the service worker's removal queue does (ADR 0018), ships in a later deploy than the check. The status is 412, not 409, because `DELETE /api/folders` already answers 409 for a folder that still holds a source, and a replaying worker must tell the two apart.

### Authentication is one statement that writes only when activity is stale

**Where:** `src/features/auth/user-data-service.ts`, `authenticateStatement()`, `UsersDataService.authenticate()`; `src/features/auth/routes/login.ts`, `createLoginRoute()`

The sid lookup and the activity stamp run in one round trip, as a data-modifying CTE that PostgreSQL runs even when the final SELECT does not read it. Each write guards itself: the session row once a minute, or early when the User-Agent changed so the session list's device label follows a browser across updates; the user row once a day; and COALESCE keeps a missing header from overwriting a known agent. An unknown, expired or inactive sid writes nothing, and with `touch` false (`GET /api/session` and the events stream's recheck) nothing is written, because polling is not activity. Login stores the request's User-Agent, null when absent, and the `"UNKNOWN"` fallback belongs to the data layer.

### The session list applies the expiry check, orders by last use, and flags the current session

**Where:** `src/features/auth/user-data-service.ts`, `UsersDataService.listSessions()`; `src/features/auth/routes/account.ts`, `createAccountRoutes()`; `src/shared/contracts/responses.ts`, `sessionsResponse`, `lastUsedAt`

The list uses `authenticate`'s expiry predicate, because retention prunes dead rows on its own schedule and a session that no longer resolves must not be listed. It is ordered by `last_used_at`, which it also shows, because the migration that added `created_at` backfilled older rows with one shared timestamp. The current session is flagged rather than filtered out, so the page labels it, keeps revoke buttons off it, and signs it out through `POST /api/logout`, which also clears the cookie. Extends ADR 0005.

## Throttle

### The throttle refund never recreates an expired key

**Where:** `src/features/auth/auth-throttle.ts`, `refundScript`

A success takes back one attempt with DECR only while the key holds a positive count. A blind DECR on a key that expired since the attempt would create it at -1 with no TTL, a counter that never expires. Extends ADR 0004.

### The throttle's account key puts the email last

**Where:** `src/features/auth/auth-throttle.ts`, `accountKey()`

The key is scope, client address, then email. An address never contains an email, so with the email last no two (address, email) pairs produce the same key. Extends ADR 0004.

### clientAddress reads the first X-Forwarded-For entry

**Where:** `src/features/auth/routes/client-address.ts`, `clientAddress()`

X-Forwarded-For is a chain proxies append to, so the first entry is what the first proxy saw. It is only as trustworthy as that proxy, which is why reading a header is opt-in through `TRUSTED_PROXY_HEADER`. Extends ADR 0004.
