// Enough of Redis for AuthThrottle, with expiry applied against a clock the
// test advances. EVAL runs the throttle's two scripts by what they do rather
// than by interpreting Lua, so auth-throttle-integration.test.ts holds the
// scripts themselves to the same behaviour against a real server.
export function createFakeThrottleRedis() {
  let now = 0;
  const counts = new Map<string, { expiresAt?: number; value: number }>();
  const live = (key: string) => {
    const entry = counts.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= now) {
      counts.delete(key);
      return undefined;
    }
    return entry;
  };
  const repairExpiry = (key: string, seconds: string) => {
    const entry = live(key);
    if (entry && entry.expiresAt === undefined) {
      entry.expiresAt = now + Number(seconds);
    }
  };
  return {
    advance(seconds: number) {
      now += seconds;
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) if (live(key) && counts.delete(key)) removed++;
      return removed;
    },
    async send(_command: "EVAL", [script = "", , ...rest]: string[]) {
      const seconds = rest.at(-1) ?? "";
      const keys = rest.slice(0, -1);
      if (script.includes("INCR")) {
        const [key = ""] = keys;
        const entry = live(key) ?? { value: 0 };
        entry.value++;
        counts.set(key, entry);
        repairExpiry(key, seconds);
        return entry.value;
      }
      return keys.map((key) => {
        repairExpiry(key, seconds);
        return live(key)?.value.toString() ?? null;
      });
    },
    // A counter left without a TTL, as an interrupted INCR-then-EXPIRE could.
    setWithoutExpiry(key: string, value: number) {
      counts.set(key, { value });
    },
    ttl(key: string) {
      const entry = live(key);
      if (!entry) return -2;
      return entry.expiresAt === undefined ? -1 : entry.expiresAt - now;
    },
  };
}
