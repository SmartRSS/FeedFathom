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

This holds for the request worker too: it returns every outcome as the job's return value (see below). In the main worker, anything a job throws, including a failure of the deferral itself (a Redis error, a poisoned `retryAt` getter), is logged and acknowledged, so BullMQ never holds a job in its failure state. The outcomes something reads stay in PostgreSQL, written by their owner: `parseSource` records a fetch or parse failure on the source row, and the WebSub subscriber a refused renewal; anything not written there is lost. The only value that leaves the processor is BullMQ's `DelayedError`, meaning "moved to delayed", and a `JobDeferral` writes its payload with `job.updateData` before `moveToDelayed`, or the retry would run the original request. If even the log call throws, that error is swallowed unlogged, because an adversarial thrown value (a poisoned custom-inspect symbol) is what made logging fail.

## Worker requests

### Work the server waits for is a request on its own queue, answered through the job's return value

**Where:** `src/platform/worker-requests.ts`, `WorkerRequests`, `answerWorkerRequest()`, `workerRequestQueueName`; `src/features/jobs/main.ts`, `MainWorker.startRequestWorker()`, `workerRequestConcurrency`; `src/worker.ts`

Find, preview, the subscribe-time preview lookup and snapshot import, mail ingest and article re-sanitizing run in the worker so the server's event loop stays free (ADR 0008, ADR 0011). The server adds a job to the `requests` queue and waits with `job.waitUntilFinished` on a `QueueEvents` listener. The worker consumes that queue with its own BullMQ `Worker` of fixed concurrency (8), so a user's request never waits behind the ParseSource backlog or a slow poll. Each feature owns its requests: `feeds` in `feed-requests.ts`, `mail-ingest` in `mail-requests.ts`, each with a server-side client and a worker-side handler list. `src/worker.ts` merges the handler lists into one map for `MainWorker`, so `jobs` dispatches by name without a feature edge to `mail-ingest`.

This channel was chosen over an HTTP endpoint on the worker. The worker's port serves only a loopback healthcheck (ADR 0020); HTTP would add a trust boundary and per-environment addressing of worker replicas in compose, Swarm and `bin/dev.ts`, while Redis already carries every server-to-worker signal. A queued request also waits for a consuming worker instead of failing during a rollout. The costs are payloads through Redis (bounded by the preview limits, the 5 MiB mail limit and the 24 MiB fetch cap for a snapshot), one more Redis connection per server, and a few milliseconds per request.

`answerWorkerRequest` never throws. It wraps the handler's value as `{ value }`, a deferral as `{ deferredUntil }` and a deadline as `{ deadlineMs }`, and logs anything else and answers `{ failed: true }`. On the server, `WorkerRequests.request` throws `HttpDeferredError` and `HttpDeadlineError` again with the same values, so the error hook maps them exactly as when the server fetched, and a failed or malformed reply becomes a plain `Error`. Each feature checks the unwrapped value against its own compiled reply schema, because the reply crossed a process boundary and a worker on another release may answer with another shape.

### Work the server does not wait for is a plain job on the main queue, run by its feature's handler

**Where:** `src/platform/worker-jobs.ts`, `WorkerJobs`, `workerJobOptions`; `src/features/jobs/main.ts`, `MainWorker.runJob()`; `src/worker.ts`; `src/features/feeds/source-jobs.ts`

The server hands the worker refreshes, WebSub pushes and WebSub discovery without waiting (ADR 0008), so that only the worker knows the job ids, markers and cache entries those touch. `WorkerJobs` adds a job by name to the main `tasks` queue with fixed options (LIFO, no finished job kept), so a feature's server side chooses only a name and the data. Each feature owns its handler list, as with requests, and `src/worker.ts` merges the lists into `jobHandlers`. `runJob` runs a registered handler before it checks a job against its own union, so `jobs` needs no edge to the feature. A handler checks its own data, and whatever it throws is logged and acknowledged like any other job.

These jobs use the main queue and not `requests` because nobody waits for them. The request worker drops a request older than its deadline, but a refresh queued while no worker runs must still run when one starts. The cost is that these jobs share the main worker's slots with ParseSource.

### A request has one deadline, on both sides

**Where:** `src/platform/worker-requests.ts`, `workerRequestTimeoutMs`, `WorkerRequests.request()`, `answerWorkerRequest()`

The server waits `workerRequestTimeoutMs` (60 s) for the whole exchange, adding the job included, and then throws `HttpDeadlineError`: a 504 for a route, and for subscribe a queued fetch. BullMQ's own wait gets one more second, so its timeout error never wins the race and turns a 504 into a 500. A job the worker starts after that deadline, measured from the job's own timestamp, is answered as failed without running, so a backlog after an outage does not do work nobody waits for. The deadline is twice the HTTP client's, so a slow host still answers as its own deadline before the request's runs out.

### A client that leaves cancels its Find or Preview request in the worker

**Where:** `src/platform/worker-requests.ts`, `WorkerRequests.request()`, `workerRequestCancelChannel`, `listenForWorkerRequestCancels()`; `src/platform/http/request-deadline.ts`, `RequestDeadline`; `src/worker.ts`; `src/features/feeds/routes/find.ts`, `src/features/feeds/routes/preview.ts`

Bun aborts `request.signal` when the browser drops the connection, and the SPA drops it often: feed discovery cancels the previous lookup on each new one, and `raceGet` aborts the loser of a stalled GET. The find and preview routes pass that signal to `WorkerRequests.request`, which joins it to the request's deadline, stops waiting, and publishes the job id on the `requests:cancel` Redis channel. Every worker subscribes on a dedicated connection and calls BullMQ's `cancelJob`, which is a no-op on workers that do not hold the job. The job's abort signal reaches the handler and its `HttpClient.get`, whose deadline aborts the outbound fetch and rate-limiter wait with the client's reason. `answerWorkerRequest` answers a cancelled job as failed without logging it, since nobody reads the reply.

Only the two requests that wait on remote hosts take the signal. Importing a snapshot and ingesting mail write data the user expects to land whether or not the tab stays open, and OPML parsing and sanitising finish too quickly to be worth a cancel. A client that leaves while the job is still being added does not cancel it; the job then runs once with no reader, as before.

### Request jobs are kept for a minute, and their event stream is short

**Where:** `src/platform/worker-requests.ts`, `workerRequestJobOptions`, `workerRequestEventsMaxLength`; `src/platform/runtime.ts`, `workerRequestQueue`

`waitUntilFinished` checks the job's state once after its listener starts, in case the job finished first. A job removed at once would then read as missing, so request jobs stay 60 seconds after they finish, unlike every other job here. BullMQ copies each return value into the queue's event stream, which keeps 10,000 entries by default; the `requests` queue keeps about 500, enough for every waiting server to read its replies, so preview replies do not pile up in Redis.

## Finished jobs

### BullMQ keeps no finished job, scheduled ticks included

**Where:** `src/features/feeds/queued-job.ts`, `finishedJobRetention`; `src/platform/worker-jobs.ts`, `workerJobOptions`; `src/features/jobs/main.ts`, `setupScheduledTasks()`

Failures are recorded in PostgreSQL by whoever owns them, so completed and failed jobs are removed at once. Request jobs on the `requests` queue are the exception, for the reason above. Each `upsertJobScheduler` passes `finishedJobRetention` as its job template, because without it every tick stays in the completed set forever; a 20-second scheduler once piled up a million entries in Redis.
