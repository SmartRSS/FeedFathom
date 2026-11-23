import { afterAll, afterEach, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { Readable } from "node:stream";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";
import { HttpClient } from "#platform/http/http-client.ts";
import type { NativeHttpTransport } from "#platform/http/http-native-transport.ts";

const redis = new RedisClient(requireDisposableRedisUrl());
const created = new Set<string>();

async function allKeys(cursor = "0", found: string[] = []): Promise<string[]> {
  const [next, keys] = await scan(cursor);
  found.push(...keys);
  return next === "0" ? found : await allKeys(next, found);
}

async function scan(cursor: string): Promise<[string, string[]]> {
  const reply = await redis.send("SCAN", [cursor, "COUNT", "1000"]);
  if (!Array.isArray(reply)) throw new Error("SCAN answered no array");
  const [next, keys] = reply;
  if (typeof next !== "string" || !Array.isArray(keys))
    throw new Error("SCAN answered an unexpected shape");
  return [next, keys.map(String)];
}

async function keysSince(before: readonly string[]) {
  const known = new Set(before);
  const added = (await allKeys()).filter((key) => !known.has(key));
  for (const key of added) created.add(key);
  return Promise.all(
    added.map(async (key) => ({
      bytes: Number(await redis.send("STRLEN", [key])),
      key,
    })),
  );
}

function serving(bodies: (Error | Uint8Array)[]): NativeHttpTransport {
  return async (url) => {
    const next = bodies.shift();
    if (!next) throw new Error("No response left");
    if (next instanceof Error) throw next;
    const body = Readable.from([next]);
    return {
      body,
      destroy: () => body.destroy(),
      headers: new Headers({ "cache-control": "max-age=60" }),
      status: 200,
      url,
    };
  };
}

const binaryBody = (length: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 7) % 256);

afterEach(async () => {
  await Promise.all([...created].map(async (key) => redis.del(key)));
  created.clear();
});

afterAll(() => {
  redis.close();
});

test("a cached binary body comes back byte for byte and costs Redis its own size", async () => {
  const url = `https://1.1.1.1/${crypto.randomUUID()}`;
  const body = binaryBody(960 * 1024);
  const client = new HttpClient(redis, { transport: serving([body]) });
  const before = await allKeys();

  expect((await client.get(url)).cached).toBe(false);
  const hit = await client.get(url);

  expect(hit.cached).toBe(true);
  expect(new Uint8Array(hit.data)).toEqual(body);
  const stored = await keysSince(before);
  const storedBytes = stored.reduce((sum, { bytes }) => sum + bytes, 0);
  expect(storedBytes).toBeGreaterThanOrEqual(body.byteLength);
  expect(storedBytes).toBeLessThan(body.byteLength + 4096);
});

test("a cached entry that lost its body is dropped whole, even when the refetch fails", async () => {
  const url = `https://1.1.1.1/${crypto.randomUUID()}`;
  const client = new HttpClient(redis, {
    deadlineMs: 1_500,
    transport: serving([
      binaryBody(16),
      binaryBody(4096),
      new Error("origin down"),
    ]),
  });
  const initial = await allKeys();
  await client.get(`https://1.1.1.1/${crypto.randomUUID()}`);
  await keysSince(initial);
  const before = await allKeys();
  await client.get(url);
  const entry = await keysSince(before);
  const [body] = entry.toSorted((left, right) => right.bytes - left.bytes);
  if (!body) throw new Error("Nothing was cached");
  await redis.del(body.key);

  await expect(client.get(url)).rejects.toThrow();

  const left = await Promise.all(
    entry.map(async ({ key }) => redis.exists(key)),
  );
  expect(left).toEqual(entry.map(() => false));
}, 10_000);
