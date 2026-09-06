# 0004 — Failed logins are counted per address and per address-account pair

- **Status:** accepted
- **Date:** 2026-09-06

## Context

`POST /api/login` accepted unlimited attempts. The route already hashes a dummy
password when no account matches, so a nonexistent account takes the same time
as a wrong password and there is no enumeration oracle in the timing. That care
buys little on its own: an attacker who cannot tell accounts apart can still
try passwords as fast as the instance answers.

The README's deployment guidance is a Caddy `reverse_proxy` with no rate
limiting of its own. An instance behind Cloudflare gets throttling for free; a
stock deployment does not, so this cannot be left to the operator having picked
a CDN.

The obvious counter — failures per account — is also the one that hands an
attacker a denial of service. Anyone who knows an address can lock its owner
out by guessing at it, from anywhere, indefinitely. That is a worse bug than
the one being fixed.

## Decision

Two Redis counters over a fifteen-minute fixed window, neither keyed on the
account alone:

| Key | Limit | Stops |
| --- | --- | --- |
| `<scope>-fail:<address>:<email>` | 10 | one source grinding one account |
| `<scope>-source:<address>` | 50 | one source spraying many accounts |

A throttled attempt returns the same `401 Wrong login data` as a wrong
password. A distinguishable status would undo the equal-time hashing by
answering "this account exists and someone is guessing at it" for free.

A successful login clears the account counter and leaves the address counter
alone. Clearing both would let an attacker holding one valid account refill the
budget they are spending against every other account from that address.

The address comes from the socket unless `TRUSTED_PROXY_HEADER` names a header
to read it from. Behind a proxy every request arrives from the proxy, so the
header is what makes the key mean anything — and trusting one with no proxy in
front to overwrite it would make the key something the client picks.

`POST /api/password-reset` is bounded the same way, under its own scope. It
sends mail to an address the caller names, so it is worth as much to an abuser
as the login form is. The scopes stay separate because a user whose first reset
mail went to spam and who asked again a few times must still be able to log in
with the password that reset then set.

## Alternatives considered

**A per-account counter.** The obvious one, and the reason for everything
above: it is a lockout anyone can trigger against anyone.

**A sliding window.** More accurate at the boundary — a fixed window lets an
attacker spend two budgets across the seam. Rejected on cost: it needs a key
per attempt rather than a key per window, and doubling the effective rate at
one instant is not what the limit is defending against.

**A delay instead of a refusal.** Tarpitting is friendlier to a user who
mistyped. Rejected because it holds a server connection open per attacker,
which is the resource the attacker is trying to spend.

**Leaving it to the reverse proxy.** What the deployment guide implicitly did.
Rejected: the guide's own example configures no limit, so the default
deployment would ship without one.

## Consequences

- A distributed attack on one account is out of reach of both counters. That is
  the deliberate price of not handing anyone a lockout.
- An operator behind a proxy who does not set `TRUSTED_PROXY_HEADER` counts
  every user against one address budget. Fifty failures in fifteen minutes
  across a whole instance is generous for a self-hosted reader, but it is
  wrong, so `docs/running.md` says so beside the proxy instructions.
- Ten wrong passwords in fifteen minutes locks a real user out of their own
  account from their own address for the rest of that window, with no message
  explaining why — the same 401 as a wrong password. Telling them would be the
  enumeration signal.
