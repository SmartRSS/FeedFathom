# 0011 — Mail ingest: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

How newsletter addresses are minted, reserved, owned and retained is recorded
in ADR 0008, beside the feeds code that implements it.

## Bounces

### Only a sender fault bounces a message, and only one signal means bounce

**Where:** `src/features/mail-ingest/email-worker.ts`, `createEmailWorker()`, `rejectionReason()`; `src/features/mail-ingest/email-handler.ts`, `MailRejectedError`, `EmailHandler.processEmail()`; `src/shared/contracts/mail-relay.ts`, `mailRelayRejectionStatus`, `MailRelayRejection`

A bounce can make a newsletter platform end the subscription, so the Worker calls `message.setReject` only when `/api/mail` answers 422 with a `{ rejected: true }` body. The server sends that only for `MailRejectedError`, thrown only when the same bytes to the same address would surely fail again. Everything else is a temporary failure the sender may retry: a proxy's HTML 413, a schema 422 from Worker/server version skew mid-deploy, the rejection flag on an unexpected status, and a mailparser result that fails `parsedMailCheck`, which is our invariant and a plain `Error`. The one bounce the Worker decides alone is an oversize message, checked by declared and encoded size before relaying, because the size is the sender's fault and `/api/mail` would refuse it too.

## The relay between the Worker and /api/mail

### The relay carries the raw message as base64

**Where:** `src/features/mail-ingest/email-worker.ts`, `toBase64()`; `src/shared/contracts/mail-relay.ts`, `MailRelayRequest`; `src/shared/contracts/requests.ts`, `incomingMailRequest`

An email is bytes, and an 8-bit body in a legacy charset sent as UTF-8 text has every such byte replaced with U+FFFD. The schema's length ceiling is therefore the base64-inflated one, and the route also checks the decoded byte length. `btoa` takes a binary string, and spreading a 5 MiB message into one `String.fromCharCode` call overflows the argument list, so the bytes are converted in 32 KiB chunks.

### The Worker validates by hand and the relay contract is plain TypeScript

**Where:** `src/features/mail-ingest/email-worker.ts`, `mailEnvelope()`; `src/shared/contracts/mail-relay.ts`, `MailRelayRequest`; `src/features/mail-ingest/routes/mail.ts`

The Worker is bundled for Cloudflare, and typebox for three string checks and one integer put 372 KB of runtime type registry, 98.7% of the bundle, on the cold-start path. The checks are hand-written and the wire contract is plain types; the server's `incomingMailRequest` schema is checked against `MailRelayRequest` where the route reads it. Moving either side to schemas brings the registry back.

### The relay endpoint is plaintext only on loopback

**Where:** `src/features/mail-ingest/email-worker.ts`, `mailEndpoint()`

The relay request carries the relay secret and the whole message, so plain http is accepted only for a host that cannot leave the machine. Any other `MAIL_ENDPOINT_DOMAIN` must resolve to an https origin.

## Storing a message

### A newsletter article's guid is its Message-ID, else its raw bytes

**Where:** `src/features/mail-ingest/email-handler.ts`, `emailGuid()`

The guid is the dedupe key. A relay that delivers one message twice, re-encoded, must not create two articles, so a normalized Message-ID is hashed. Two different messages without a Message-ID must not collapse, so those hash the raw bytes.

### mailparser's result is checked, not trusted

**Where:** `src/features/mail-ingest/email-handler.ts`, `parsedMailCheck`

mailparser's types promise more than its runtime guarantees, so the fields the handler reads are checked against a compiled schema. The `parse` constructor parameter exists only so tests can reach this check, which no real message triggers.

### Newsletter recipients are matched in lowercase; feed URLs keep their case

**Where:** `src/shared/contracts/requests.ts`, `normalizedMailRecipient`; `src/shared/validation/typebox-policy.ts`, `normalizedSubscriptionTarget`

The recipient is matched exactly against `sources.url`, and minted addresses are lowercase, so the inbound recipient and an email-address subscription target are both lowercased; otherwise a sender echoing the address capitalised would be reported unknown. A feed URL keeps its case because its path is case-sensitive.

### Newsletter articles live under a path no route serves

**Where:** `src/shared/util/safe-url.ts`, `newsletterArticlePath()`, `safeArticleUrl()`

A newsletter article has no page of its own. The handler stores each under `/article/<guid>`, which keeps the URL unique per message, and since no route serves that path, `safeArticleUrl` gives such articles no link instead of one that opens "Page not found".

## Configuration

### mailDomain's presence is the SPA's only mail-ingest signal

**Where:** `src/shared/contracts/responses.ts`, `sessionResponse.mailDomain`

The field is present only where mail ingest is configured, and the SPA reads its presence as the sole sign that email subscriptions are accepted. Always sending it would offer newsletter subscriptions on an instance that can never receive their mail.
