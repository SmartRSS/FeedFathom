---
name: verify-source-enqueue
description: Model-check how refresh requests coalesce onto the ParseSource job, with TLA+. Use when a change touches `enqueueSource`, `enqueueDueSources`, `runParse` or the `mergeQueuedRefresh` script in `src/features/feeds/source-enqueue.ts`, `processJob` or `deferred()` in `src/features/jobs/main.ts`, `JobDeferral` or `finishedJobRetention` in `src/features/feeds/queued-job.ts`, or when `bin/model-check.sh` fails.
---

# Verify refresh coalescing on the ParseSource job

**Property.** Every refresh request that `enqueueSource` acknowledges is followed, before the source's `ParseSource-<id>` job is gone, by a parse that starts after the request with `skipCache` at least as strong as the request asked.

**Harm.** A pushed article or a refresh click waits for the next poll, which is up to a day for a verified WebSub source, or a manual refresh is answered from the cache.

The model is `src/features/feeds/__tests__/source-enqueue-model/SourceEnqueue.tla`. It describes the code at the sync commit and does not read the code. A code change is caught only after you make the model describe it. A green check on an unchanged model says nothing about your diff.

## 1. Find what your change touches

Run:

```sh
git diff 9842b2dcc0c60a797dd1b97141ed33af7fb83eb8 -- src/features/feeds/source-enqueue.ts src/features/jobs/main.ts src/features/feeds/queued-job.ts
```

Also count a BullMQ upgrade (`bun.lock`) that changes `getState`, `add`, `updateData`, `moveToActive`, `moveToDelayed` or `moveToFinished`. For each hunk, find the rows in the code map below whose code it changes.

Done when every hunk is matched to a model action, or is shown to change nothing the model describes (logging, types, another job name).

## 2. Make the model describe the code

Edit the matched actions in `SourceEnqueue.tla` so that each one does what the new code does. Keep one action per indivisible step in the code: one Redis command, one Lua script, or one BullMQ script. Code that awaits between two Redis calls is two actions, because another request or the worker can run in between. Take new names from the code. Keep the model free of comments, as ADR 0023 asks, and record the mapping in the code map below.

A new step that has no row in the code map gets a new action and a new row.

Done when every row you touched in the code map is true of the new code.

## 3. Run the check

```sh
bin/model-check.sh
```

It needs Java 11 or later, `curl` and `sha256sum`, and no Bun. It downloads `tla2tools.jar` 1.7.4 into `.cache/model-check/` and checks its SHA-256. It runs each config below with one TLC worker, so a counterexample is the same on every run. The whole run takes about 7 seconds. Each config prints `ok` or `FAIL`, and the script exits non-zero if any config differs from its expected outcome. The full TLC output of each config is in `.cache/model-check/<config>.log`. CI runs the same script in the Lint job of `.github/workflows/quality.yml`.

| Config | Invariant | Expected | What it pins |
| --- | --- | --- | --- |
| `current` | `RefreshAnsweredOutsideKnownRaces` | passes | The current code keeps the property outside the two known races. |
| `finding-strict` | `RefreshAnsweredBeforeIdle` | violated | The strict property. Fails today on the add-lost race. |
| `finding-marked-late` | `RefreshAnsweredUnlessAddLost` | violated | The marked-late race. |
| `finding-add-lost` | `RefreshAnsweredUnlessMarkedLate` | violated | The add-lost race. |
| `replay-issue-813` | `RefreshAnsweredOutsideKnownRaces` | violated | Reverts 8a766cec (`addWithoutLooking`). |
| `replay-d1a82e4d` | `RefreshAnsweredOutsideKnownRaces` | violated | Reverts d1a82e4d (`followUpThroughEnqueue`). |
| `replay-issue-845` | `RefreshAnsweredOutsideKnownRaces` | violated | Reverts f5876a0f (`mergeInSteps`). |
| `replay-issue-847` | `RefreshAnsweredOutsideKnownRaces` | violated | Reverts 4af6806e (`deferralDropsFollowUp`). |

The expectations live in the `check` lines at the end of `bin/model-check.sh`.

## 4. Read the result

Read every counterexample, and every passing run you want explained, with the pstack `/statechart` skill (`/pstack:statechart` in Claude Code). It tells each violation as its shortest path in plain words, shows which violations a model change removes, and charts the states of a passing model. It works on a scratch copy of the model. When it asks for the file and line of each condition, take them from the code map below and add them to that copy only.

- **`current` fails.** The modeled change breaks the property. Walk the trace one action at a time against the code map and ask whether the code allows that step at that point. If one step is impossible in the code, for example because the model splits what one Lua script does, the model is wrong: fix the model and rerun. Otherwise the bug is real: fix the code and leave the invariant as it is. A real bug can be confirmed against Redis in the style of `src/features/feeds/__tests__/source-enqueue-integration.test.ts`, which forces an interleaving through a queue wrapper whose `getJob` does the racing step.
- **A `finding-*` config passes.** The change closed a known race. Delete its excuse from `RefreshAnsweredOutsideKnownRaces` (`StrandedOnMarker` for marked-late, `FetchedWithoutBypass` for add-lost), delete the config and its `check` line, and update the findings below. When both are closed, point `current` at `RefreshAnsweredBeforeIdle` and delete `finding-strict`.
- **A `replay-*` config passes.** The model can no longer see that past bug, usually because an edit moved the code path its flag reverts. Make the flag describe the old code again. `git show <commit>` shows that code.
- **`TypeOK` fails, TLC reports a deadlock, or TLC cannot parse the model.** The model is broken, not the code.

When the change fixes a new bug in this protocol, add a flag to `RevertibleFixes` that restores the old behaviour and a `replay-*` config whose expected outcome is a violation, and watch it fail before you commit.

## 5. Move the sync commit

Replace the commit in step 1 and in the coverage record below with the new commit only after the code map is true of the code at that commit and `bin/model-check.sh` exits 0.

## Code map

Line numbers are at the sync commit. `job` is the BullMQ state of `ParseSource-<id>`, with `"none"` meaning no job key. `jobSkipCache` is that job's `data.skipCache`, with a missing value read as `FALSE`. `marker` is the Redis key `pending_parse_refresh:<id>`. `worker` is where the processor is, `request` and `followUp` are the `skipCache` of `runParse`'s `request` and `followUp`, `caller[r]` is where request `r` is inside `enqueueSource`, and `asked[r]` is its `skipCache` argument. `owed`, `fetchedSince`, `markedLate` and `addLost` record history for the invariants and have no code.

| Action | Code |
| --- | --- |
| `EnqueueSource(r)` | `enqueueSource` is called and runs `bullmqQueue.getJob(jobId)`, `source-enqueue.ts:81-88`. Under `addWithoutLooking` it goes straight to `add`, as before 8a766cec. |
| `GetState(r)` | `holder.getState()`, `source-enqueue.ts:89`, one BullMQ script (`getStateV2-8.lua`). A vanished job reads `unknown` and falls through to `add`. |
| `MergeQueuedRefresh(r)` | `redis.eval(mergeQueuedRefresh, ...)`, `source-enqueue.ts:24-42` and `:91-104`. A missing job key returns 0 and falls through to `add`; a job in neither `wait`, `paused` nor `delayed` gets the marker. |
| `MergePendingRefresh(r)` | `mergePendingRefresh`, `source-enqueue.ts:106-109` and `:156-160`. One `SET`, or one `SET NX` for `"0"`. |
| `TakeBeforeUpdateData(r)`, `UpdateQueuedData(r)` | Only under `mergeInSteps`: the waiting branch at `f5876a0f^`, a `GETDEL` and then `holder.updateData`, which throws when the job key is gone. |
| `Add(r)` | `bullmqQueue.add(..., { jobId })`, `source-enqueue.ts:111-115`. BullMQ drops an add whose job key exists (`addStandardJob-9.lua`, `handleDuplicatedJob`). |
| `EnqueueDueSources` | `enqueueDueSources` `addBulk` with payload `{ id }`, `source-enqueue.ts:118-126`, called by `MainWorker` at startup and on each `GatherJobs` run, `main.ts:114-119` and `:170-173`. |
| `PromoteDelayed` | BullMQ moves a due delayed job to `wait` (`promoteDelayedJobs` inside `moveToActive-11.lua`). |
| `MoveToActive` | BullMQ `moveToActive-11.lua` moves the job to `active` and returns its data in the same script; `runJob` reads it as `input.data`, `main.ts:152` and `:181`. |
| `ParseRequest` | `runParse` runs `parse(request)`, `source-enqueue.ts:132`, which is `feedParser.parseSource`. An `HttpDeferredError` reaches `deferred()` and goes to `moveToDelayed`, `main.ts:121-134`. |
| `TakePendingRefresh` | `takePendingRefresh`, one `GETDEL`, `source-enqueue.ts:133-134` and `:149-154`. |
| `ParseFollowUp` | `parse(followUp)`, `source-enqueue.ts:135-146`. A deferral throws `JobDeferral(retryAt, followUp)`. Under `deferralDropsFollowUp` it goes to `moveToDelayed` with the original data, as before 4af6806e. |
| `ReenqueueFollowUp` | Only under `followUpThroughEnqueue`: 8a766cec's `runPendingRefresh` called `enqueueSource` from the processor, saw its own job active and wrote the marker back. |
| `UpdateDeferredData` | `deferred()` runs `job.updateData(error.data)` for a `JobDeferral`, `main.ts:132`. |
| `MoveToDelayed` | `job.moveToDelayed(retryAt, token)`, `main.ts:133`, then `DelayedError`. |
| `MoveToFinished` | The processor returns and BullMQ `moveToFinished-14.lua` removes the job key, because `finishedJobRetention` keeps zero finished jobs, `queued-job.ts:12-15`. |

The invariants hold when `job = "none"`, that is, when nothing is queued, delayed or running for the source:

- `RefreshAnsweredBeforeIdle`: every acknowledged request has been answered.
- `StrandedOnMarker(r)`: `r` wrote the marker when no run would take it, because the job was gone or the active run was past `takePendingRefresh` and not deferring, and the marker still holds `r`'s bypass.
- `FetchedWithoutBypass(r)`: `r` saw no job, its `add` was dropped because a job appeared in between, and a parse still started after `r`.
- `RefreshAnsweredOutsideKnownRaces`: every acknowledged request was answered, is `StrandedOnMarker`, or is `FetchedWithoutBypass`.

## Known findings in the current code

Both were reproduced against BullMQ 6.6.0 and Redis 7 by a scratch integration test that was not committed: the add-lost race through a queue wrapper whose `getJob` runs `enqueueDueSources` before it returns, and the marked-late race through a real `Worker` whose processor calls `enqueueSource` after `runParse` returns, which reaches `mergePendingRefresh`.

- **Add lost** (`finding-strict`, `finding-add-lost`). A manual refresh calls `getJob` and finds no `ParseSource-<id>`. The poll's `addBulk` creates the job with payload `{ id }`. The refresh's `add` is dropped as a duplicate, and `enqueueSource` returns. The worker parses without `skipCache`, `takePendingRefresh` finds no marker, and the job is removed. The refresh is answered from the cache. A WebSub push with a seeded body (`skipCache` false) that adds first does the same.
- **Marked late** (`finding-marked-late`). A poll job is waiting. A manual refresh's `getState` returns `waiting`. The worker pops the job, parses without `skipCache`, and `takePendingRefresh` finds nothing. The refresh's `mergeQueuedRefresh` now finds the job active and sets the marker to `"1"`. The job is removed, and the marker waits for the next poll or request. `mergePendingRefresh` strands a request the same way when it lands after the run's take.

## Past bugs the replays fail on

- **`addWithoutLooking`**, #813, fixed by 8a766cec. A poll job is waiting. A manual refresh calls `add`, which BullMQ drops. The job parses without `skipCache`.
- **`followUpThroughEnqueue`**, fixed by d1a82e4d. A refresh's `mergeQueuedRefresh` finds the job just popped and sets the marker. The run parses, takes the marker, and sends the follow-up back through `enqueueSource`, which sees its own job active and writes the marker back. The job ends with the refresh unanswered.
- **`mergeInSteps`**, #845, fixed by f5876a0f. A refresh's `getState` returns `waiting` and it takes the marker. The worker pops the job with `skipCache` unset. The refresh's `updateData` writes `skipCache: true` onto the running job, too late.
- **`deferralDropsFollowUp`**, #847, fixed by 4af6806e. A refresh sets the marker during the run. The run takes it, and the follow-up parse defers. `moveToDelayed` keeps the original payload, so the retry parses without `skipCache` and finds no marker.

## Scope

- One source. Each source has its own job id and marker, so sources meet only in the worker pool and the rate limiter, which the model covers by letting any parse defer.
- Three requests, each calling `enqueueSource` once with either `skipCache`, against any number of polls, deferrals and retries. The state space is finite because nothing counts. `current` explores 52,855 distinct states. A run with four requests also passes, with 503,522 distinct states in about 12 seconds.
- One processor per job id, as BullMQ guarantees while the lock holds.
- Assumed: every Redis command and BullMQ script succeeds, a lock never expires, the queue is not paused, and the source exists and is not an email source. A parse that does not defer counts as a fetch even when it fails, because `parseSource` records the failure on the source row (ADR 0012).
- Timing is not modeled. A delayed job can be promoted at any moment, and a poll can run at any moment.
- `EnqueueSource` merges the call with its `getJob`, so a parse that starts between the two counts as before the request. This makes the check stricter, never looser.
- Not checked: that a stranded marker is eventually taken (a liveness property), the `trigger` field, and failures of `findSourceById`, Redis or `moveToDelayed`.

## Coverage record

- Sync commit: `9842b2dcc0c60a797dd1b97141ed33af7fb83eb8`.
- `src/features/feeds/source-enqueue.ts`: `mergeQueuedRefresh`, `SourceEnqueuer.enqueueSource`, `enqueueDueSources`, `runParse`, `takePendingRefresh`, `mergePendingRefresh`.
- `src/features/jobs/main.ts`: `MainWorker.processJob`, `deferred`, the `ParseSource` case of `runJob`, `enqueueDueSources`.
- `src/features/feeds/queued-job.ts`: `finishedJobRetention`, `JobDeferral`.
- BullMQ 6.6.0: `getState`, `add`, `addBulk`, `updateData`, `moveToActive`, `moveToDelayed`, `moveToFinished`.
