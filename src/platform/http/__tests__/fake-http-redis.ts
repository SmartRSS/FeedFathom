// Enough of Redis for the HTTP client, with millisecond expiry applied on
// every read: the rate limiter's whole behaviour is about when a key stops
// existing, and a reservation that never expires makes every retry look like
// a violation. EVAL runs the four scripts the client sends by what each one
// does rather than by interpreting Lua.
export function createFakeHttpRedis() {
  const expiry = new Map<string, number>();
  const values = new Map<string, string>();
  const deleted: string[] = [];
  const live = (key: string) => {
    const expiresAt = expiry.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      expiry.delete(key);
      values.delete(key);
    }
    return values.get(key);
  };
  const pttl = (key: string) => {
    if (live(key) === undefined) return -2;
    const expiresAt = expiry.get(key);
    return expiresAt === undefined ? -1 : expiresAt - Date.now();
  };
  // INCR and DECR keep an existing expiry and give a new key none.
  const add = (key: string, by: number) => {
    const next = Number(live(key) ?? "0") + by;
    values.set(key, String(next));
    return next;
  };
  const evaluate = ([
    script = "",
    ,
    key = "",
    arg = "",
    ttl = "",
  ]: string[]) => {
    // The host clock: take it once ARGV[1] ms have passed since the last
    // request, or report how long is left.
    if (script.includes("TIME")) {
      const now = Date.now();
      const last = live(key);
      if (last !== undefined && now - Number(last) < Number(arg)) {
        return Number(last) + Number(arg) - now;
      }
      values.set(key, String(now));
      expiry.set(key, now + Number(ttl));
      return 0;
    }
    if (script.includes("PEXPIRE")) {
      add(key, 1);
      if (pttl(key) < Number(arg)) expiry.set(key, Date.now() + Number(arg));
      return null;
    }
    if (script.includes("DECR")) {
      const waiters = live(key);
      if (waiters === undefined) return 0;
      if (Number(waiters) <= 1) {
        values.delete(key);
        expiry.delete(key);
        return 1;
      }
      return add(key, -1);
    }
    // The cache lock release: delete only while the token still matches.
    if (live(key) !== arg) return 0;
    values.delete(key);
    expiry.delete(key);
    return 1;
  };
  return {
    async del(key: string) {
      deleted.push(key);
      expiry.delete(key);
      values.delete(key);
      return 1;
    },
    deleted,
    async get(key: string) {
      return live(key) ?? null;
    },
    pttl,
    seed(key: string, value: string, ttlMs: number) {
      values.set(key, value);
      expiry.set(key, Date.now() + ttlMs);
    },
    async send(command: string, args: string[]) {
      if (command !== "EVAL") throw new Error(`Unexpected ${command}`);
      return evaluate(args);
    },
    async set(key: string, value: string, ...options: Array<number | string>) {
      if (options.includes("NX") && live(key) !== undefined) return null;
      const px = options.indexOf("PX");
      if (px === -1) expiry.delete(key);
      else expiry.set(key, Date.now() + Number(options[px + 1]));
      values.set(key, value);
      return "OK";
    },
    values,
  };
}
