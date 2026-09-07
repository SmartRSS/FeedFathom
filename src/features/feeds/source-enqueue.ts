import { JobName } from "#shared/types/job-name-enum.ts";

export type SourceParseQueue = {
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

/**
 * Enqueues ParseSource jobs for sources that already exist. Orchestration,
 * not storage: a data service loads the sources, this hands them to the
 * worker -- callers compose the two explicitly.
 */
export class SourceEnqueuer {
  constructor(private readonly bullmqQueue: SourceParseQueue) {}

  // skipCache defaults on because every caller here is an explicit signal
  // that something changed. The exception is a WebSub push that arrived with
  // the feed document attached: that body is already in the cache by the time
  // this is called, and skipping it would re-request what the hub just sent.
  public async enqueueSource(
    source: { id: number; url: string },
    trigger: "manual" | "websub-push" = "manual",
    skipCache = true,
  ) {
    await this.bullmqQueue.add(
      JobName.ParseSource,
      { id: source.id, skipCache, trigger, url: source.url },
      {
        jobId: `${JobName.ParseSource}-${source.id}`,
        lifo: true,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    );
  }
}
