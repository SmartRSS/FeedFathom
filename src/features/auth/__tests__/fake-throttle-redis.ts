// Enough of Redis for AuthThrottle's counting, without expiry. EVAL runs the
// throttle's scripts by what they do rather than by interpreting Lua; each
// call completes before it yields, as a script on a real server is atomic.
// The window, its expiry and the TTL repair are held to the real scripts in
// auth-throttle-integration.test.ts against a real server.
export function createFakeThrottleRedis() {
  const counts = new Map<string, number>();
  return {
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) if (counts.delete(key)) removed++;
      return removed;
    },
    async send(_command: "EVAL", [script = "", , key = ""]: string[]) {
      const value = counts.get(key) ?? 0;
      if (script.includes("DECR")) {
        if (value > 0) counts.set(key, value - 1);
        return 0;
      }
      counts.set(key, value + 1);
      return [value + 1, -1];
    },
  };
}
