// Enough of Redis for AuthThrottle's counting, without expiry. EVAL runs the
// throttle's two scripts by what they count rather than by interpreting Lua;
// the window, its expiry and the TTL repair are held to the real scripts in
// auth-throttle-integration.test.ts against a real server.
export function createFakeThrottleRedis() {
  const counts = new Map<string, number>();
  return {
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) if (counts.delete(key)) removed++;
      return removed;
    },
    async send(_command: "EVAL", [script = "", , ...rest]: string[]) {
      const keys = rest.slice(0, -1);
      if (script.includes("INCR")) {
        const [key = ""] = keys;
        const value = (counts.get(key) ?? 0) + 1;
        counts.set(key, value);
        return value;
      }
      return keys.map((key) => counts.get(key)?.toString() ?? null);
    },
  };
}
