import { type Queue, Worker } from "bullmq";
import type Redis from "ioredis";

export async function takeQueuedJobs(
  queue: Queue,
  connection: Redis,
  count: number,
) {
  const worker = new Worker<{ id: number }>(queue.name, null, { connection });
  const token = crypto.randomUUID();
  const taken: { id: number; name: string }[] = [];
  try {
    while (taken.length < count) {
      // eslint-disable-next-line no-await-in-loop -- Jobs are taken in queue order.
      const job = await worker.getNextJob(token, { block: false });
      if (!job) break;
      taken.push({ id: job.data.id, name: job.name });
      // eslint-disable-next-line no-await-in-loop -- Jobs are taken in queue order.
      await job.moveToCompleted(null, token, false);
    }
  } finally {
    await worker.close();
  }
  return taken;
}
