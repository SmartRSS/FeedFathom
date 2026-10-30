// A fixed-window counter: the TTL is set when the counter first appears and
// the whole count expires together, which costs one key per window instead of
// one per hit. INCR and EXPIRE run in one script, so no interruption can leave
// a counter that never expires; TTL -1 (a key without an expiry, written
// before that held) gets a fresh window.
//
// `windowCountLua` defines `countInWindow(key, seconds)` for a caller's own
// script to call, so a script that gates one counter on another keeps the
// same counting rule rather than a copy of it.
export const windowCountLua = `
local function repairWindow(key, seconds)
  local ttl = redis.call('TTL', key)
  if ttl == -1 then
    redis.call('EXPIRE', key, seconds)
    return seconds
  end
  return ttl
end
local function countInWindow(key, seconds)
  local count = redis.call('INCR', key)
  return count, repairWindow(key, seconds)
end`;

const countScript = `${windowCountLua}
local count, ttl = countInWindow(KEYS[1], tonumber(ARGV[1]))
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
