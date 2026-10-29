import { expect, mock, spyOn, test } from "bun:test";

const migrated = Promise.withResolvers<void>();
const initializeCalled = Promise.withResolvers<void>();
const workerConsuming = Promise.withResolvers<void>();

// The service modules the entrypoint wires only store these.
await mock.module("#platform/config.ts", () => ({ config: {} }));
await mock.module("#platform/runtime.ts", () => ({
  bullmqQueue: {},
  bullmqRedis: {},
  async close() {},
  drizzleConnection: { $client: {} },
  httpClient: {},
  redis: {},
}));
await mock.module("#platform/db/connection.ts", () => ({
  waitForMigration: () => migrated.promise,
}));
await mock.module("#features/jobs/main.ts", () => ({
  MainWorker: class {
    async cleanup() {}
    async initialize() {
      initializeCalled.resolve();
      await workerConsuming.promise;
    }
  },
}));

// The worker binds port 3000; an ephemeral port keeps this test from
// colliding with anything else on the machine.
const serve = Bun.serve;
const listening = Promise.withResolvers<URL>();
spyOn(Bun, "serve").mockImplementation((options) => {
  const server = serve(
    Object.assign(options, { hostname: "127.0.0.1", port: 0 }),
  );
  listening.resolve(server.url);
  return server;
});

test("the worker reports healthy only once its job worker is consuming", async () => {
  const started = import("../worker.ts");
  const healthcheck = new URL("/healthcheck", await listening.promise);
  const status = async () => (await fetch(healthcheck)).status;

  expect(await status()).toBe(503);

  // Migrated, but BullMQ is still waiting on Redis: a rollout must not treat
  // this worker as a replacement yet.
  migrated.resolve();
  await initializeCalled.promise;
  expect(await status()).toBe(503);

  workerConsuming.resolve();
  await started;
  expect(await status()).toBe(200);
});
