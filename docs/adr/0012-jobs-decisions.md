# 0012 — Jobs: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## The worker loop

### The worker acknowledges every job and keeps failure state in PostgreSQL

**Where:** `src/features/jobs/main.ts`, `MainWorker.processJob`, `deferred()`; `src/features/feeds/feed-parser.ts`, `FeedParser`

Anything a job throws, including a failure of the deferral itself (a Redis error, a poisoned `retryAt` getter), is logged and acknowledged, so BullMQ never holds a job in its failure state. The outcomes something reads stay in PostgreSQL, written by their owner: `parseSource` records a fetch or parse failure on the source row, and the WebSub subscriber a refused renewal; anything not written there is lost. The only value that leaves the processor is BullMQ's `DelayedError`, meaning "moved to delayed", and a `JobDeferral` writes its payload with `job.updateData` before `moveToDelayed`, or the retry would run the original request. If even the log call throws, that error is swallowed unlogged, because an adversarial thrown value (a poisoned custom-inspect symbol) is what made logging fail.

## Finished jobs

### BullMQ keeps no finished job, scheduled ticks included

**Where:** `src/features/feeds/queued-job.ts`, `finishedJobRetention`; `src/features/jobs/main.ts`, `setupScheduledTasks()`

Failures are recorded in PostgreSQL by whoever owns them, so completed and failed jobs are removed at once. Each `upsertJobScheduler` passes `finishedJobRetention` as its job template, because without it every tick stays in the completed set forever; a 20-second scheduler once piled up a million entries in Redis.
