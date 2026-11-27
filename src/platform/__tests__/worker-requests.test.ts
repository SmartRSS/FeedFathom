import type { QueueEvents } from "bullmq";
import { expect, test } from "bun:test";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { HttpDeadlineError } from "#platform/http/request-deadline.ts";
import {
  answerWorkerRequest,
  listenForWorkerRequestCancels,
  workerRequestCancelChannel,
  type WorkerRequestCancels,
  workerRequestJobOptions,
  type WorkerRequestQueue,
  WorkerRequests,
} from "#platform/worker-requests.ts";

const events = () => strictFake<QueueEvents>({}, "queueEvents");
const noCancels = strictFake<WorkerRequestCancels>({}, "cancels");

const answering = (reply: unknown, added: unknown[][] = []) =>
  new WorkerRequests(
    {
      add: async (...args) => {
        added.push(args);
        return { waitUntilFinished: async () => reply };
      },
    },
    events,
    noCancels,
  );

const never = new Promise<never>(() => {});

test("a request queues a job and resolves with the worker's value", async () => {
  const added: unknown[][] = [];

  const value = await answering({ value: { ok: 1 } }, added).request("NAME", {
    a: 1,
  });

  expect(value).toEqual({ ok: 1 });
  expect(added).toEqual([["NAME", { a: 1 }, workerRequestJobOptions]]);
});

test("a deferral or deadline in the worker is raised again in the server", async () => {
  const retryAt = Date.now() + 5_000;

  await expect(
    answering({ deferredUntil: retryAt }).request("NAME", {}),
  ).rejects.toEqual(new HttpDeferredError(retryAt));
  await expect(
    answering({ deadlineMs: 30_000 }).request("NAME", {}),
  ).rejects.toEqual(new HttpDeadlineError(30_000));
});

test("a failed or malformed reply is an error", async () => {
  await expect(answering({ failed: true }).request("NAME", {})).rejects.toThrow(
    "Worker request NAME failed",
  );
  await expect(answering({ other: 1 }).request("NAME", {})).rejects.toThrow(
    "Invalid NAME reply",
  );
});

test("a request nobody answers fails as a deadline once the timeout passes", async () => {
  const waits: (number | undefined)[] = [];
  const queue: WorkerRequestQueue = {
    add: async () => ({
      waitUntilFinished: async (_events, ttl) => {
        waits.push(ttl);
        return never;
      },
    }),
  };

  const request = new WorkerRequests(queue, events, noCancels, 20).request(
    "NAME",
    {},
  );

  await expect(request).rejects.toBeInstanceOf(HttpDeadlineError);
  expect(waits).toHaveLength(1);
  expect(waits[0]).toBeGreaterThan(20);
});

test("a request whose job cannot even be queued fails as a deadline", async () => {
  const queue: WorkerRequestQueue = { add: async () => never };

  const request = new WorkerRequests(queue, events, noCancels, 20).request(
    "NAME",
    {},
  );

  await expect(request).rejects.toBeInstanceOf(HttpDeadlineError);
});

test("a client that goes away rejects the request and cancels its job", async () => {
  const published: string[][] = [];
  const queue: WorkerRequestQueue = {
    add: async () => ({ id: "7", waitUntilFinished: async () => never }),
  };
  const cancels: WorkerRequestCancels = {
    publish: async (channel, jobId) => published.push([channel, jobId]),
  };
  const client = new AbortController();

  const request = new WorkerRequests(queue, events, cancels).request(
    "NAME",
    {},
    client.signal,
  );
  await Bun.sleep(0);
  client.abort(new Error("gone"));

  await expect(request).rejects.toThrow("gone");
  expect(published).toEqual([[workerRequestCancelChannel, "7"]]);
});

test("the worker hands its job's signal to the handler and stays quiet when cancelled", async () => {
  const job = { data: {}, name: "WAIT", timestamp: Date.now() };
  const cancelled = new AbortController();
  const handlers = new Map([
    [
      "WAIT",
      async (_data: unknown, signal?: AbortSignal) => {
        cancelled.abort();
        signal?.throwIfAborted();
        return {};
      },
    ],
  ]);

  expect(await answerWorkerRequest(job, handlers, cancelled.signal)).toEqual({
    failed: true,
  });
});

test("cancels heard on the channel reach the worker", async () => {
  const subscribed: string[] = [];
  const cancelled: string[] = [];
  const listeners: ((channel: string, jobId: string) => void)[] = [];

  await listenForWorkerRequestCancels(
    {
      on: (_event, listener) => listeners.push(listener),
      subscribe: async (channel) => subscribed.push(channel),
    },
    (jobId) => cancelled.push(jobId),
  );
  for (const listener of listeners) {
    listener("other", "1");
    listener(workerRequestCancelChannel, "2");
  }

  expect(subscribed).toEqual([workerRequestCancelChannel]);
  expect(cancelled).toEqual(["2"]);
});
