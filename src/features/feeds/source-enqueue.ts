import { type Static, Type } from "typebox";
import { JobName } from "#features/feeds/job-name-enum.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import {
  finishedJobRetention,
  JobDeferral,
} from "#features/feeds/queued-job.ts";

export const parseSourceJobData = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  skipCache: Type.Optional(Type.Boolean()),
  // Absent on a scheduled poll.
  trigger: Type.Optional(
    Type.Union([Type.Literal("manual"), Type.Literal("websub-push")]),
  ),
});
export type ParseRequest = Static<typeof parseSourceJobData>;

// One job id per source, so BullMQ dedupes a second add while one is queued
// and the merge script below finds the queued one.
const parseSourceJobId = (sourceId: number) =>
  `${JobName.ParseSource}-${sourceId}`;

const mergeQueuedRefresh = `
local stored = redis.call('HGET', KEYS[1], 'data')
if not stored then return 0 end
local incoming = cjson.decode(ARGV[2])
if redis.call('LPOS', KEYS[3], ARGV[1]) or
   redis.call('LPOS', KEYS[4], ARGV[1]) or
   redis.call('ZSCORE', KEYS[5], ARGV[1]) then
  local existing = cjson.decode(stored)
  local pending = redis.call('GET', KEYS[2])
  incoming.skipCache = incoming.skipCache == true or existing.skipCache == true or pending == '1'
  redis.call('HSET', KEYS[1], 'data', cjson.encode(incoming))
  redis.call('DEL', KEYS[2])
elseif incoming.skipCache then
  redis.call('SET', KEYS[2], '1')
else
  redis.call('SET', KEYS[2], '0', 'NX')
end
return 1
`;

export type SourceParseJobHandle = {
  getState(): Promise<string>;
};

export type SourceParseQueue = {
  toKey(name: string): string;
  // BullMQ's own getJob resolves undefined when the job record is gone.
  getJob(jobId: string): Promise<SourceParseJobHandle | null | undefined>;
  add(
    name: JobName,
    data: ParseRequest,
    options: typeof finishedJobRetention & { jobId: string; lifo: boolean },
  ): Promise<unknown>;
  addBulk(
    jobs: {
      data: ParseRequest;
      name: JobName;
      opts: typeof finishedJobRetention & { jobId: string };
    }[],
  ): Promise<unknown>;
};

export type SourceParseRedis = {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
  set(key: string, value: string, mode?: "NX"): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
};

/**
 * Queues ParseSource jobs, and runs them: a request that arrives while its
 * source's job is running is parsed by that same run before it ends.
 */
export class SourceEnqueuer {
  // One key per source. "1" means a request asked to bypass the cache, "0"
  // that none did; writes are ordered so "1" always dominates ("1" overwrites
  // unconditionally, "0" only lands on an empty key), which keeps the merge
  // correct without read-modify-write: a burst of requests coalesces into
  // the strongest bypass any of them asked for (#813).
  private readonly pendingKeyPrefix = "pending_parse_refresh:";

  constructor(
    private readonly bullmqQueue: SourceParseQueue,
    private readonly redis: SourceParseRedis,
  ) {}

  // skipCache defaults on because every caller here is an explicit signal
  // that something changed. The exception is a WebSub push that arrived with
  // the feed document attached: that body is already in the cache by the time
  // this is called, and skipping it would re-request what the hub just sent.
  public async enqueueSource(
    source: { id: number },
    trigger: NonNullable<ParseRequest["trigger"]> = "manual",
    skipCache = true,
  ) {
    const payload = { id: source.id, skipCache, trigger };
    const jobId = parseSourceJobId(source.id);
    const holder = await this.bullmqQueue.getJob(jobId);
    const state = holder ? await holder.getState() : null;

    if (holder && (state === "waiting" || state === "delayed")) {
      const merged = await this.redis.eval(
        mergeQueuedRefresh,
        5,
        this.bullmqQueue.toKey(jobId),
        `${this.pendingKeyPrefix}${source.id}`,
        this.bullmqQueue.toKey("wait"),
        this.bullmqQueue.toKey("paused"),
        this.bullmqQueue.toKey("delayed"),
        jobId,
        JSON.stringify(payload),
      );
      if (merged === 1) return;
    }

    if (holder && state === "active") {
      // The worker is mid-run holding this id, so BullMQ dedupes the add
      // away -- and the caller (a hub, a user's refresh button) has already
      // been answered. Record the request instead: the run takes everything
      // that accumulated when it ends and parses the source once more itself
      // (#813). It cannot come back through here to do that -- the id is
      // still active until its processor returns.
      await this.mergePendingRefresh(source.id, skipCache);
      return;
    }

    await this.bullmqQueue.add(JobName.ParseSource, payload, {
      ...finishedJobRetention,
      jobId,
      lifo: true,
    });
  }

  /** Queues a scheduled poll of each source, behind any explicit request. */
  public async enqueueDueSources(sources: readonly { id: number }[]) {
    await this.bullmqQueue.addBulk(
      sources.map((source) => ({
        data: { id: source.id },
        name: JobName.ParseSource,
        opts: { ...finishedJobRetention, jobId: parseSourceJobId(source.id) },
      })),
    );
  }

  /**
   * Runs one ParseSource job through `parse`. Requests that landed mid-run
   * were recorded on a marker rather than queued, because BullMQ would have
   * deduped their add against this job (#813). Queueing them now would hit
   * that same dedupe -- the id stays active until the job returns -- so the
   * run parses once more itself, the way the newest request asked. Anything
   * arriving during that pass stays on the marker: a deferral, the next poll
   * or the next request all reach it.
   */
  public async runParse(
    request: ParseRequest,
    parse: (request: ParseRequest) => Promise<void>,
  ) {
    await parse(request);
    const pending = await this.takePendingRefresh(request.id);
    if (!pending) return;
    const followUp: ParseRequest = {
      ...request,
      skipCache: pending.skipCache,
      trigger: "manual",
    };
    try {
      await parse(followUp);
    } catch (error) {
      // The marker is gone, so a retry of the original request would lose
      // the follow-up's intent (#847).
      if (error instanceof HttpDeferredError)
        throw new JobDeferral(error.retryAt, followUp);
      throw error;
    }
  }

  // The requests that piled up while a job held the source's id, coalesced
  // into one. Null means nothing arrived during the run. The take is the
  // consume: whatever lands after it belongs to the next run.
  private async takePendingRefresh(
    sourceId: number,
  ): Promise<{ skipCache: boolean } | null> {
    const value = await this.redis.getdel(
      `${this.pendingKeyPrefix}${sourceId}`,
    );
    return value === null ? null : { skipCache: value === "1" };
  }

  private async mergePendingRefresh(sourceId: number, skipCache: boolean) {
    const key = `${this.pendingKeyPrefix}${sourceId}`;
    // A cache bypass swallows a plain refresh; a plain refresh must not
    // swallow a bypass. Unconditional set for "1", fill-only-if-empty for
    // "0", so concurrent merges can never downgrade the pending request.
    if (skipCache) await this.redis.set(key, "1");
    else await this.redis.set(key, "0", "NX");
  }
}
