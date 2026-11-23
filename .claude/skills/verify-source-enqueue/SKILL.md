---
name: verify-source-enqueue
description: Model-check how refresh requests coalesce onto the ParseSource job, with TLA+. Use when a change touches `enqueueSource`, `enqueueDueSources`, `requeuePendingRefresh`, `runParse` or the `mergeQueuedRefresh` script in `src/features/feeds/source-enqueue.ts`, `processJob`, `deferred()`, the ParseSource case of `runJob` or the `completed` listener in `src/features/jobs/main.ts`, `JobDeferral` or `finishedJobRetention` in `src/features/feeds/queued-job.ts`, or when `bin/model-check.sh` fails.
---

# Verify refresh coalescing on the ParseSource job

**Property.** Every refresh request that `enqueueSource` acknowledges is followed, before the source has no `ParseSource-<id>` job and no pending requeue, by a parse that starts after the request with `skipCache` at least as strong as the request asked.

**Harm.** A pushed article or a refresh click waits for the next poll, which is up to a day for a verified WebSub source, or a manual refresh is answered from the cache.

The model is `src/features/feeds/__tests__/source-enqueue-model/SourceEnqueue.tla`. It describes the code at the sync commit and does not read the code. A code change is caught only after you make the model describe it. A green check on an unchanged model says nothing about your diff.

## 1. Find what your change touches

Run:

```sh
git diff 67811c59870d598b1d9cd7f99f15bde881fb66c6 -- src/features/feeds/source-enqueue.ts src/features/jobs/main.ts src/features/feeds/queued-job.ts
```

Also count a BullMQ upgrade (`bun.lock`) that changes `getState`, `add`, `updateData`, `moveToActive`, `moveToDelayed`, `moveToFinished` or when the Worker emits `completed`. For each hunk, find the rows in the code map below whose code it changes.

Done when every hunk is matched to a model action, or is shown to change nothing the model describes (logging, types, another job name).

## 2. Make the model describe the code

Edit the matched actions in `SourceEnqueue.tla` so that each one does what the new code does. Keep one action per indivisible step in the code: one Redis command, one Lua script, or one BullMQ script. Code that awaits between two Redis calls is two actions, because another request or the worker can run in between. Take new names from the code. Keep the model free of comments, as ADR 0023 asks, and record the mapping in the code map below.

A new step that has no row in the code map gets a new action and a new row.

Done when every row you touched in the code map is true of the new code.

## 3. Run the check

```sh
bin/model-check.sh
```

It needs Java 11 or later, `curl` and `sha256sum`, and no Bun. It downloads `tla2tools.jar` 1.7.4 into `.cache/model-check/` and checks its SHA-256. It runs each config below with one TLC worker, so a counterexample is the same on every run. The whole run takes about 6 seconds. Each config prints `ok` or `FAIL`, and the script exits non-zero if any config differs from its expected outcome. The full TLC output of each config is in `.cache/model-check/<config>.log`. CI runs the same script in the Lint job of `.github/workflows/quality.yml`.

Every config checks `RefreshAnsweredBeforeIdle`.

| Config | Expected | What it pins |
| --- | --- | --- |
| `current` | passes | The current code keeps the property. |
| `replay-issue-813` | violated | Reverts 8a766cec (`addWithoutLooking`). |
| `replay-d1a82e4d` | violated | Reverts d1a82e4d (`followUpThroughEnqueue`). |
| `replay-issue-845` | violated | Reverts f5876a0f (`mergeInSteps`). |
| `replay-issue-847` | violated | Reverts 4af6806e (`deferralDropsFollowUp`). |
| `replay-issue-1196` | violated | Reverts the mark before an unmerged add (`addWithoutMarking`). |
| `replay-issue-1197` | violated | Reverts the post-finish requeue (`markWithoutRequeue`). |

The expectations live in the `check` lines at the end of `bin/model-check.sh`.

## 4. Read the result

Read every counterexample, and every passing run you want explained, with the pstack `/statechart` skill (`/pstack:statechart` in Claude Code). It tells each violation as its shortest path in plain words, shows which violations a model change removes, and charts the states of a passing model. It works on a scratch copy of the model. When it asks for the file and line of each condition, take them from the code map below and add them to that copy only.

- **`current` fails.** The modeled change breaks the property. Walk the trace one action at a time against the code map and ask whether the code allows that step at that point. If one step is impossible in the code, for example because the model splits what one Lua script does, the model is wrong: fix the model and rerun. Otherwise the bug is real: fix the code and leave the invariant as it is. Confirm a real bug against Redis and a real BullMQ worker in the style of `src/features/jobs/__tests__/refresh-race-integration.test.ts`, which forces an interleaving by pausing the worker inside a Redis call or by doing the racing step inside a queue wrapper's `getJob` or `getState`.
- **A `replay-*` config passes.** The model can no longer see that past bug, usually because an edit moved the code path its flag reverts. Make the flag describe the old code again. `git show <commit>` shows that code.
- **`TypeOK` fails, TLC reports a deadlock, or TLC cannot parse the model.** The model is broken, not the code.

When the change fixes a new bug in this protocol, add a flag to `RevertibleFixes` that restores the old behaviour and a `replay-*` config whose expected outcome is a violation, and watch it fail before you commit.

## 5. Move the sync commit

Replace the commit in step 1 and in the coverage record below with the new commit only after the code map is true of the code at that commit and `bin/model-check.sh` exits 0.

## Code map

Line numbers are at the sync commit. `job` is the BullMQ state of `ParseSource-<id>`, with `"none"` meaning no job key. `jobSkipCache` is that job's `data.skipCache`, with a missing value read as `FALSE`. `marker` is the Redis key `pending_parse_refresh:<id>`. `worker` is where the processor is, and `request` is the `skipCache` the run parses with. `checking` and `adding` are post-finish steps that the `completed` listener has started: `checking` means at least one has not read the marker yet, and `adding` means at least one has read a marker and has not added the job yet. `caller[r]` is where request `r` is inside `enqueueSource`, and `asked[r]` is its `skipCache` argument. `followUp` and `taken` exist only for replays. `owed` records history for the invariant and has no code.

| Action | Code |
| --- | --- |
| `EnqueueSource(r)` | `enqueueSource` is called and runs `bullmqQueue.getJob(jobId)`, `source-enqueue.ts:82-89`. With no job it goes to `MergePendingRefresh`. Under `addWithoutLooking` it goes straight to `add`, as before 8a766cec. |
| `GetState(r)` | `holder.getState()`, `source-enqueue.ts:90`, one BullMQ script (`getStateV2-8.lua`). `waiting` and `delayed` go to the merge script. Any other state, including `unknown` for a vanished job, goes to `MergePendingRefresh`. |
| `MergeQueuedRefresh(r)` | `redis.eval(mergeQueuedRefresh, ...)`, `source-enqueue.ts:24-42` and `:92-105`. A missing job key returns 0 and goes to `MergePendingRefresh`. A job in neither `wait`, `paused` nor `delayed` gets the marker in the same script, while its key still exists. |
| `MergePendingRefresh(r)` | `mergePendingRefresh`, `source-enqueue.ts:107` and `:165-169`. One `SET`, or one `SET NX` for `"0"`. Then `Add`. |
| `MarkActive(r)` | Only under `markWithoutRequeue`: before 4c61a905, `enqueueSource` answered an `active` state with `mergePendingRefresh` alone and did not add. |
| `TakeBeforeUpdateData(r)`, `UpdateQueuedData(r)` | Only under `mergeInSteps`: the waiting branch at `f5876a0f^`, a `GETDEL` and then `holder.updateData`, which throws when the job key is gone. |
| `Add(r)` | `addParseJob(payload)`, `source-enqueue.ts:108` and `:150-156`. BullMQ drops an add whose job key exists (`addStandardJob-9.lua`, `handleDuplicatedJob`). Under `addWithoutMarking` an unmerged request comes here without writing the marker, as before 4c61a905. |
| `EnqueueDueSources` | `enqueueDueSources` `addBulk` with payload `{ id }`, `source-enqueue.ts:117-125`, called by `MainWorker` at startup and on each `GatherJobs` run, `main.ts:111-126` and `:177-179`. |
| `PromoteDelayed` | BullMQ moves a due delayed job to `wait` (`promoteDelayedJobs` inside `moveToActive-11.lua`). |
| `MoveToActive` | BullMQ `moveToActive-11.lua` moves the job to `active` and returns its data in the same script; `runJob` reads it as `input.data`, `main.ts:159` and `:182-183`. |
| `TakePendingRefresh` | `takePendingRefresh`, one `GETDEL`, before the parse, `source-enqueue.ts:131` and `:158-163`. A taken value is ORed into `skipCache`, `:136-140`. The email and missing-source checks run inside `parse`, after the take, `main.ts:183-190`. |
| `ParseRequest` | `parse(data)` or `parse(request)`, `source-enqueue.ts:133` and `:142`, which looks the source up and runs `feedParser.parseSource`, `main.ts:183-190`. An `HttpDeferredError` reaches `deferred()` and goes to `moveToDelayed`, `main.ts:136-141`. After a take it is rethrown as `JobDeferral(retryAt, request)`, `source-enqueue.ts:143-146`. Under `deferralDropsFollowUp` it goes to `moveToDelayed` with the original data, as before 4af6806e. Under `followUpThroughEnqueue` a finished parse goes to `TakeForReenqueue`. |
| `UpdateDeferredData` | `deferred()` runs `job.updateData(error.data)` for a `JobDeferral`, `main.ts:139`. A run that took no marker throws the plain error and writes nothing, which matches the model's write of an unchanged value. |
| `MoveToDelayed` | `job.moveToDelayed(retryAt, token)`, `main.ts:140`, then `DelayedError`. |
| `TakeForReenqueue`, `ReenqueueFollowUp` | Only under `followUpThroughEnqueue`: the run takes the marker after its parse and sends it back through `enqueueSource` from inside the processor, as 8a766cec's `runPendingRefresh` did. `enqueueSource` sees its own job active, writes the marker back, and its add is dropped. Nothing runs after the job finishes. |
| `MoveToFinished` | The processor returns and BullMQ `moveToFinished-14.lua` removes the job key, because `finishedJobRetention` keeps zero finished jobs, `queued-job.ts:12-15`. The Worker then emits `completed` (`handleCompleted` in BullMQ's `worker.js`), and the listener at `main.ts:245-247` starts a post-finish step. Under `followUpThroughEnqueue` and `markWithoutRequeue` no step starts. |
| `CheckPendingRefresh` | `requeuePendingRefresh`, `main.ts:206-217`, runs `SourceEnqueuer.requeuePendingRefresh`, which reads the marker with one `EXISTS`, `source-enqueue.ts:111-113`. |
| `RequeuePendingRefresh` | `addParseJob({ id })`, `source-enqueue.ts:114`, with the same job id, so BullMQ drops it if a job exists. |

The property holds in `Idle`, when nothing is queued, delayed, running or about to be requeued for the source: `job = "none"` and no post-finish step is pending.

- `RefreshAnsweredBeforeIdle`: every acknowledged request has been answered.

## Closed findings

Both were found by this model and reproduced against BullMQ 6.6.0 and Redis 7. `refresh-race-integration.test.ts` forces each interleaving. Its four race tests fail on the code before 4c61a905 and pass after it.

- **Add lost** (#1196, `replay-issue-1196`). A manual refresh called `getJob` and found no `ParseSource-<id>`. The poll's `addBulk` created the job with payload `{ id }`, the refresh's `add` was dropped as a duplicate, and the job parsed without `skipCache`. A request that merges nothing now writes the marker before it adds, and the run takes the marker before its parse.
- **Marked late** (#1197, `replay-issue-1197`). A refresh's `getState` returned `waiting`, the worker took and parsed the job, and the refresh's merge script then found it active and set the marker after the run had read it. A request that reached `mergePendingRefresh` after the run's take did the same. The finished job was removed and the marker waited for the next poll. Now the `completed` listener re-adds the job when a marker is waiting, and a request that saw an active job also adds, in case the job finished before its marker landed.

## Past bugs the replays fail on

- **`addWithoutLooking`**, #813, fixed by 8a766cec. A poll job is waiting. A manual refresh calls `add`, which BullMQ drops. The job parses without `skipCache`.
- **`followUpThroughEnqueue`**, fixed by d1a82e4d. A refresh lands while the job runs. The run passes it back through `enqueueSource` before BullMQ removes the job, so the add is dropped and the marker is stranded. The shortest counterexample has the refresh land after the run's in-processor take.
- **`mergeInSteps`**, #845, fixed by f5876a0f. A refresh's `getState` returns `waiting` and it takes the marker. The worker pops the job with `skipCache` unset. The refresh's `updateData` writes `skipCache: true` onto the running job, too late.
- **`deferralDropsFollowUp`**, #847, fixed by 4af6806e. A run takes a bypass from the marker and its parse defers. `moveToDelayed` keeps the original payload, so the retry parses without `skipCache` and finds no marker.
- **`addWithoutMarking`**, #1196, fixed by 4c61a905. See Closed findings.
- **`markWithoutRequeue`**, #1197, fixed by 4c61a905. See Closed findings.

## Scope

- One source. Each source has its own job id and marker, so sources meet only in the worker pool and the rate limiter, which the model covers by letting any parse defer.
- Three requests, each calling `enqueueSource` once with either `skipCache`, against any number of polls, deferrals and retries. The state space is finite because nothing counts. `current` explores 80,184 distinct states. A run with four requests also passes, with 539,718 distinct states in about 14 seconds.
- One processor per job id, as BullMQ guarantees while the lock holds. Post-finish steps run beside the processor, because a new job for the source can start before the previous job's `completed` listener reads the marker. Several steps can be pending at once. The model keeps one flag per step kind and lets each step either leave others pending or not, so it checks more interleavings than the code allows.
- Assumed: every Redis command and BullMQ script succeeds, a lock never expires, the worker process does not stop between `moveToFinished` and its `completed` listener, the queue is not paused, and the source exists and is not an email source. A parse that does not defer counts as a fetch even when it fails, because `parseSource` records the failure on the source row (ADR 0012).
- Timing is not modeled. A delayed job can be promoted at any moment, and a poll can run at any moment.
- `EnqueueSource` merges the call with its `getJob`, so a parse that starts between the two counts as before the request. This makes the check stricter, never looser.
- Not checked: that a stranded marker is eventually taken, and that the requeue stops. Both are liveness properties. A run that skipped its take would requeue its job forever and never reach `Idle`, which this invariant does not see. `refresh-race-integration.test.ts` pins that an email source's run takes its marker and runs once. Also not checked: the `trigger` field, and failures of `findSourceById`, Redis or `moveToDelayed`.

## Coverage record

- Sync commit: `67811c59870d598b1d9cd7f99f15bde881fb66c6`.
- `src/features/feeds/source-enqueue.ts`: `mergeQueuedRefresh`, `SourceEnqueuer.enqueueSource`, `requeuePendingRefresh`, `enqueueDueSources`, `runParse`, `addParseJob`, `takePendingRefresh`, `mergePendingRefresh`.
- `src/features/jobs/main.ts`: `MainWorker.processJob`, `deferred`, the `ParseSource` case of `runJob`, `requeuePendingRefresh`, the `completed` listener in `startWorker`, `enqueueDueSources`.
- `src/features/feeds/queued-job.ts`: `finishedJobRetention`, `JobDeferral`.
- BullMQ 6.6.0: `getState`, `add`, `addBulk`, `updateData`, `moveToActive`, `moveToDelayed`, `moveToFinished`, and the `completed` event after `moveToFinished`.
