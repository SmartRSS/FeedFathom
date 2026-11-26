import type { QueueEvents } from "bullmq";
import { expect, test } from "bun:test";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { HttpDeadlineError } from "#platform/http/request-deadline.ts";
import {
  workerRequestJobOptions,
  type WorkerRequestQueue,
  WorkerRequests,
} from "#platform/worker-requests.ts";

const events = () => strictFake<QueueEvents>({}, "queueEvents");

const answering = (reply: unknown, added: unknown[][] = []) =>
  new WorkerRequests(
    {
      add: async (...args) => {
        added.push(args);
        return { waitUntilFinished: async () => reply };
      },
    },
    events,
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

  const request = new WorkerRequests(queue, events, 20).request("NAME", {});

  await expect(request).rejects.toBeInstanceOf(HttpDeadlineError);
  expect(waits).toHaveLength(1);
  expect(waits[0]).toBeGreaterThan(20);
});

test("a request whose job cannot even be queued fails as a deadline", async () => {
  const queue: WorkerRequestQueue = { add: async () => never };

  const request = new WorkerRequests(queue, events, 20).request("NAME", {});

  await expect(request).rejects.toBeInstanceOf(HttpDeadlineError);
});
