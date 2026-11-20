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
  const reply: unknown[] = Array.isArray(result) ? result : [];
  const [count, ttl] = reply;
  return { count: Number(count ?? 0), ttl: Number(ttl ?? windowSeconds) };
}
