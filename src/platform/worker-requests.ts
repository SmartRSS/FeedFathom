import type { Job, QueueEvents } from "bullmq";
import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import {
  HttpDeadlineError,
  RequestDeadline,
} from "#platform/http/request-deadline.ts";

export const workerRequestQueueName = "requests";
export const workerRequestTimeoutMs = 60_000;
export const workerRequestEventsMaxLength = 500;
const listenerGraceMs = 1_000;

export const workerRequestJobOptions = {
  removeOnComplete: { age: 60 },
  removeOnFail: { age: 60 },
} as const;

const exact = { additionalProperties: false } as const;
const workerReply = Type.Union([
  Type.Object({ value: Type.Unknown() }, exact),
  Type.Object({ deferredUntil: Type.Number() }, exact),
  Type.Object({ deadlineMs: Type.Number() }, exact),
  Type.Object({ failed: Type.Literal(true) }, exact),
]);
const workerReplyCheck = Schema.Compile(workerReply);
export type WorkerReply = Static<typeof workerReply>;

export type WorkerRequestHandler = (data: unknown) => Promise<unknown>;
export type WorkerRequestHandlers = ReadonlyMap<string, WorkerRequestHandler>;

export type WorkerRequestQueue = {
  add(
    name: string,
    data: object,
    options: typeof workerRequestJobOptions,
  ): Promise<Pick<Job, "waitUntilFinished">>;
};

export function checked<T>(
  validator: { Check(value: unknown): value is T },
  value: unknown,
  what: string,
): T {
  if (!validator.Check(value)) throw new Error(`Invalid ${what}`);
  return value;
}

function unwrap(name: string, reply: unknown): unknown {
  const checkedReply = checked(workerReplyCheck, reply, `${name} reply`);
  if ("value" in checkedReply) return checkedReply.value;
  if ("deferredUntil" in checkedReply)
    throw new HttpDeferredError(checkedReply.deferredUntil);
  if ("deadlineMs" in checkedReply)
    throw new HttpDeadlineError(checkedReply.deadlineMs);
  throw new Error(`Worker request ${name} failed`);
}

export class WorkerRequests {
  constructor(
    private readonly queue: WorkerRequestQueue,
    private readonly events: () => QueueEvents,
    private readonly timeoutMs = workerRequestTimeoutMs,
  ) {}

  async request(name: string, data: object): Promise<unknown> {
    const deadline = new RequestDeadline(this.timeoutMs);
    try {
      return unwrap(name, await deadline.run(this.send(name, data)));
    } finally {
      deadline.dispose();
    }
  }

  private async send(name: string, data: object): Promise<unknown> {
    const job = await this.queue.add(name, data, workerRequestJobOptions);
    return job.waitUntilFinished(
      this.events(),
      this.timeoutMs + listenerGraceMs,
    );
  }
}

export async function answerWorkerRequest(
  job: { data: unknown; name: string; timestamp: number },
  handlers: WorkerRequestHandlers,
): Promise<WorkerReply> {
  try {
    if (Date.now() - job.timestamp > workerRequestTimeoutMs)
      throw new Error(`Worker request ${job.name} expired before it ran`);
    const handler = handlers.get(job.name);
    if (!handler) throw new Error(`Unknown worker request ${job.name}`);
    return { value: await handler(job.data) };
  } catch (error: unknown) {
    if (error instanceof HttpDeferredError)
      return { deferredUntil: error.retryAt };
    if (error instanceof HttpDeadlineError)
      return { deadlineMs: error.milliseconds };
    try {
      console.error(`Error answering ${job.name} request:`, error);
    } catch {}
    return { failed: true };
  }
}
