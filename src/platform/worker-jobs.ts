const workerJobOptions = {
  lifo: true,
  removeOnComplete: { count: 0 },
  removeOnFail: { count: 0 },
} as const;

export type WorkerJobHandler = (data: unknown) => Promise<void>;
export type WorkerJobHandlers = ReadonlyMap<string, WorkerJobHandler>;

export type WorkerJobQueue = {
  add(
    name: string,
    data: object,
    options: typeof workerJobOptions,
  ): Promise<unknown>;
};

export class WorkerJobs {
  constructor(private readonly queue: WorkerJobQueue) {}

  async add(name: string, data: object): Promise<void> {
    await this.queue.add(name, data, workerJobOptions);
  }
}
