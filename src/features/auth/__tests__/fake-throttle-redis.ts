// Enough of Redis for AuthThrottle. Counters only, and expiry is recorded
// rather than applied: no test here waits out a fifteen-minute window, but
// several assert that the TTL is set exactly once per window.
export function createFakeThrottleRedis() {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  return {
    counts,
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) if (counts.delete(key)) removed++;
      return removed;
    },
    async expire(key: string, seconds: number) {
      if (!counts.has(key)) return 0;
      expiries.set(key, seconds);
      return 1;
    },
    expiries,
    async incr(key: string) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async mget(...keys: string[]) {
      return keys.map((key) => counts.get(key)?.toString() ?? null);
    },
  };
}
