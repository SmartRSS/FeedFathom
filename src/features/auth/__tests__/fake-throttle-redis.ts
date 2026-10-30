// Enough of Redis for AuthThrottle's counting, without expiry. EVAL runs the
// throttle's scripts by what they do rather than by interpreting Lua; each
// call completes before it yields, as a script on a real server is atomic.
// The window, its expiry and the TTL repair are held to the real scripts in
// auth-throttle-integration.test.ts against a real server.
export function createFakeThrottleRedis() {
  const counts = new Map<string, number>();
  const count = (key: string) => {
    const value = (counts.get(key) ?? 0) + 1;
    counts.set(key, value);
    return value;
  };
  return {
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) if (counts.delete(key)) removed++;
      return removed;
    },
    async send(_command: "EVAL", [script = "", keyCount, ...rest]: string[]) {
      const keys = rest.slice(0, Number(keyCount));
      const [, accountLimit, addressLimit] = rest.slice(keys.length);
      const [account = "", source] = keys;
      if (script.includes("DECR")) {
        const value = counts.get(account) ?? 0;
        if (value > 0) counts.set(account, value - 1);
        return 0;
      }
      if (
        source !== undefined &&
        (counts.get(source) ?? 0) >= Number(addressLimit)
      ) {
        return 0;
      }
      if (count(account) > Number(accountLimit)) return 0;
      if (source !== undefined) count(source);
      return 1;
    },
  };
}
