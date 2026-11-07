import { expect, spyOn, test } from "bun:test";
import type { MainWorker } from "#features/jobs/main.ts";
import { healthcheckPath } from "#platform/http/internal-routes.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { runWorker } from "../worker-app.ts";

test("the worker reports healthy only once its job worker is consuming", async () => {
  const migrated = Promise.withResolvers<void>();
  const initializeCalled = Promise.withResolvers<void>();
  const workerConsuming = Promise.withResolvers<void>();

  // runWorker registers SIGTERM/SIGINT handlers; left in place they would
  // call this test's fakes if a later file's run were interrupted.
  const onSpy = spyOn(process, "on").mockReturnValue(process);
  const { ready, server } = runWorker({
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
    port: 0,
    waitForMigration: () => migrated.promise,
  });

  try {
    const healthcheck = new URL(healthcheckPath, server.url);
    const status = async () => (await fetch(healthcheck)).status;

    expect(await status()).toBe(503);

    // Migrated, but BullMQ is still waiting on Redis: a rollout must not
    // treat this worker as a replacement yet.
    migrated.resolve();
    await initializeCalled.promise;
    expect(await status()).toBe(503);

    workerConsuming.resolve();
    await ready;
    expect(await status()).toBe(200);
  } finally {
    onSpy.mockRestore();
    await server.stop();
  }
});
