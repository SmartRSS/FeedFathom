import { JobName } from "#shared/types/job-name-enum.ts";

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
    data: {
      id: number;
      skipCache: boolean;
      trigger?: "manual" | "websub-push";
      url: string;
    },
    options: {
      jobId: string;
      lifo: boolean;
      removeOnComplete: { count: number };
      removeOnFail: { count: number };
    },
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
 * Enqueues ParseSource jobs for sources that already exist. Orchestration,
 * not storage: a data service loads the sources, this hands them to the
 * worker -- callers compose the two explicitly.
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
    source: { id: number; url: string },
    trigger: "manual" | "websub-push" = "manual",
    skipCache = true,
  ) {
    const payload = { id: source.id, skipCache, trigger, url: source.url };
    const holder = await this.bullmqQueue.getJob(
      `${JobName.ParseSource}-${source.id}`,
    );
    const state = holder ? await holder.getState() : null;

    if (holder && (state === "waiting" || state === "delayed")) {
      const jobId = `${JobName.ParseSource}-${source.id}`;
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
      jobId: `${JobName.ParseSource}-${source.id}`,
      lifo: true,
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 0 },
    });
  }

  /**
   * Takes the refresh requests that piled up while a job held the source's
   * id, coalesced into one request. Null means nothing arrived during the
   * run and no follow-up is owed. The take is the consume: whatever lands
   * after it belongs to the next run.
   */
  public async takePendingRefresh(
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
