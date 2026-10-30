import { expect, spyOn, test } from "bun:test";
import type { MainWorker } from "#features/jobs/main.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { runWorker } from "../worker-app.ts";

test("the worker reports healthy only once its job worker is consuming", async () => {
  const migrated = Promise.withResolvers<void>();
  const initializeCalled = Promise.withResolvers<void>();
  const workerConsuming = Promise.withResolvers<void>();

  // The worker binds port 3000; an ephemeral port keeps this test from
  // colliding with anything else on the machine.
  const serve = Bun.serve;
  const listening = Promise.withResolvers<ReturnType<typeof serve>>();
  const serveSpy = spyOn(Bun, "serve").mockImplementation((options) => {
    const server = serve(
      Object.assign(options, { hostname: "127.0.0.1", port: 0 }),
    );
    listening.resolve(server);
    return server;
  });

  try {
    const started = runWorker({
      async close() {},
      mainWorker: strictFake<MainWorker>(
        {
          async initialize() {
            initializeCalled.resolve();
            await workerConsuming.promise;
          },
        },
        "mainWorker",
      ),
      waitForMigration: () => migrated.promise,
    });
    const healthcheck = new URL("/healthcheck", (await listening.promise).url);
    const status = async () => (await fetch(healthcheck)).status;

    expect(await status()).toBe(503);

    // Migrated, but BullMQ is still waiting on Redis: a rollout must not
    // treat this worker as a replacement yet.
    migrated.resolve();
    await initializeCalled.promise;
    expect(await status()).toBe(503);

    workerConsuming.resolve();
    await started;
    expect(await status()).toBe(200);
  } finally {
    serveSpy.mockRestore();
    await (await listening.promise).stop();
  }
});
