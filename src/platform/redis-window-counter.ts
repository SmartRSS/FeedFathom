// A fixed-window counter: the TTL is set when the counter first appears and
// the whole count expires together, which costs one key per window instead of
// one per hit. INCR and EXPIRE run as one script, so no interruption can leave
// a counter that never expires; TTL -1 (a key without an expiry, written
// before that held) gets a fresh window.
const countScript = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;

export type CounterRedis = {
  send(command: "EVAL", args: string[]): Promise<unknown>;
};

/** Counts one hit on `key`; returns the new count and the window's seconds left. */
export async function countInWindow(
  redis: CounterRedis,
  key: string,
  windowSeconds: number,
): Promise<{ count: number; ttl: number }> {
  const result = await redis.send("EVAL", [
    countScript,
    "1",
    key,
    windowSeconds.toString(),
  ]);
  const [count, ttl]: unknown[] = Array.isArray(result) ? result : [];
  return { count: Number(count ?? 0), ttl: Number(ttl ?? windowSeconds) };
}
