import { afterAll, expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";

// Stands between the runtime and Redis. While muted it forwards nothing and
// holds new connections open without answering: an outage that drops packets
// rather than refusing them, as a partition or a vanished host does.
const upstream = new URL(requireDisposableRedisUrl());
let muted = false;
const links = new Set<[Socket, Socket]>();
const proxy = createServer((client) => {
  client.on("error", () => {});
  if (muted) return;
  const server = connect(Number(upstream.port || 6379), upstream.hostname);
  server.on("error", () => {});
  client.pipe(server).pipe(client);
  const link: [Socket, Socket] = [client, server];
  links.add(link);
  client.on("close", () => links.delete(link));
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address();
if (address === null || typeof address === "string") {
  throw new Error("The proxy has no TCP address");
}
const proxied = new URL(upstream);
proxied.hostname = "127.0.0.1";
proxied.port = String(address.port);
process.env["REDIS_URL"] = proxied.href;
process.env["DATABASE_URL"] ??= "postgresql://localhost/feedfathom_test";

const { bullmqRedis, close, redis } = await import("#platform/runtime.ts");

afterAll(() => {
  void close();
  proxy.close();
});

const pong = async (): Promise<string> =>
  await redis.ping().catch(async () => {
    await Bun.sleep(500);
    return await pong();
  });

test("the Bun client reconnects after a connect attempt times out", async () => {
  // The Bun client connects before the runtime opens any other connection.
  const [bunLink] = links;
  if (!bunLink) throw new Error("The Bun client never connected");
  muted = true;
  bunLink[0].destroy();
  // The reconnect lands on the muted proxy and waits out its timeout.
  await Bun.sleep(2_000);
  muted = false;

  expect(await pong()).toBe("PONG");
}, 30_000);

test("close() gives up on a Redis that stopped answering", async () => {
  await bullmqRedis.ping();
  muted = true;
  for (const [client, server] of links) {
    client.unpipe(server);
    server.unpipe(client);
  }

  const started = performance.now();
  await close();
  expect(performance.now() - started).toBeLessThan(10_000);
}, 20_000);
