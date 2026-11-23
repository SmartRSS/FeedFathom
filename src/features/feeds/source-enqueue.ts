import { type Static, Type } from "typebox";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import {
  finishedJobRetention,
  JobDeferral,
  JobName,
} from "#features/feeds/queued-job.ts";

export const parseSourceJobData = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  skipCache: Type.Optional(Type.Boolean()),
  trigger: Type.Optional(
    Type.Union([Type.Literal("manual"), Type.Literal("websub-push")]),
  ),
});
export type ParseRequest = Static<typeof parseSourceJobData>;

export const parseSourceJobId = (sourceId: number) =>
  `${JobName.ParseSource}-${sourceId}`;

export const pendingParseRefreshKey = (sourceId: number) =>
  `pending_parse_refresh:${sourceId}`;

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
  exists(key: string): Promise<number>;
  set(key: string, value: string, mode?: "NX"): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
};

export class SourceEnqueuer {
  constructor(
    private readonly bullmqQueue: SourceParseQueue,
    private readonly redis: SourceParseRedis,
  ) {}

  public async enqueueSource(
    source: { id: number },
    trigger: NonNullable<ParseRequest["trigger"]> = "manual",
    skipCache = true,
  ) {
    const payload = { id: source.id, skipCache, trigger };
    const jobId = parseSourceJobId(source.id);
    const holder = await this.bullmqQueue.getJob(jobId);
    const state = holder ? await holder.getState() : null;

    if (state === "waiting" || state === "delayed") {
      const merged = await this.redis.eval(
        mergeQueuedRefresh,
        5,
        this.bullmqQueue.toKey(jobId),
        pendingParseRefreshKey(source.id),
        this.bullmqQueue.toKey("wait"),
        this.bullmqQueue.toKey("paused"),
        this.bullmqQueue.toKey("delayed"),
        jobId,
        JSON.stringify(payload),
      );
      if (merged === 1) return;
    }

    await this.mergePendingRefresh(source.id, skipCache);
    await this.addParseJob(payload);
  }

  public async requeuePendingRefresh(sourceId: number) {
    const pending = await this.redis.exists(pendingParseRefreshKey(sourceId));
    if (pending === 0) return;
    await this.addParseJob({ id: sourceId });
  }

  public async enqueueDueSources(sources: readonly { id: number }[]) {
    await this.bullmqQueue.addBulk(
      sources.map((source) => ({
        data: { id: source.id },
        name: JobName.ParseSource,
        opts: { ...finishedJobRetention, jobId: parseSourceJobId(source.id) },
      })),
    );
  }

  public async runParse(
    data: ParseRequest,
    parse: (request: ParseRequest) => Promise<void>,
  ) {
    const pending = await this.takePendingRefresh(data.id);
    if (!pending) {
      await parse(data);
      return;
    }
    const request: ParseRequest = {
      ...data,
      skipCache: data.skipCache === true || pending.skipCache,
      trigger: data.trigger ?? "manual",
    };
    try {
      await parse(request);
    } catch (error) {
      if (error instanceof HttpDeferredError)
        throw new JobDeferral(error.retryAt, request);
      throw error;
    }
  }

  private async addParseJob(data: ParseRequest) {
    await this.bullmqQueue.add(JobName.ParseSource, data, {
      ...finishedJobRetention,
      jobId: parseSourceJobId(data.id),
      lifo: true,
    });
  }

  private async takePendingRefresh(
    sourceId: number,
  ): Promise<{ skipCache: boolean } | null> {
    const value = await this.redis.getdel(pendingParseRefreshKey(sourceId));
    return value === null ? null : { skipCache: value === "1" };
  }

  private async mergePendingRefresh(sourceId: number, skipCache: boolean) {
    const key = pendingParseRefreshKey(sourceId);
    if (skipCache) await this.redis.set(key, "1");
    else await this.redis.set(key, "0", "NX");
  }
}
