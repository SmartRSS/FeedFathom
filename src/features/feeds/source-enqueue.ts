import { JobName } from "#shared/types/job-name-enum.ts";

// The slice of a BullMQ job this enqueuer needs: enough to see how a job is
// currently queued and to rewrite the payload of one still waiting to run.
export type SourceParseJobHandle = {
  data: {
    id: number;
    skipCache?: boolean;
    trigger?: "manual" | "websub-push";
    url?: string;
  };
  getState(): Promise<string>;
  updateData(data: unknown): Promise<void>;
};

export type SourceParseQueue = {
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

// The marker and the take are single-command Redis operations, so any client
// that can GET/SET NX/GETDEL works -- bullmq's own connection in production.
export type SourceParseRedis = {
  get(key: string): Promise<string | null>;
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
      // A queued poll still carries its bare poll payload, so an add here
      // would be deduped away and the refresh would run without the cache
      // bypass it asked for. Instead the pending flags -- this request's plus
      // anything that accumulated earlier -- are folded into the one queued
      // job, so exactly one fetch runs and it fetches like the newest
      // request asked.
      const pending = await this.takePendingRefresh(source.id);
      await holder.updateData({
        ...payload,
        skipCache: skipCache || (pending?.skipCache ?? false),
      });
      return;
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
