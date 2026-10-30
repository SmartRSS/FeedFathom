import {
  type CounterRedis,
  countInWindow,
} from "#platform/redis-window-counter.ts";

// Attempts are counted in Redis and the count gates further ones.
// Two counters per scope, neither keyed on the account alone: an attacker who
// knows a real address must not be able to lock its owner out by guessing at
// it from somewhere else.
//
//   (client address, account) -- one source grinding one account
//   (client address)          -- one source spraying many accounts
//
// A distributed attack on one account is out of reach of both, which is the
// price of not handing anyone a lockout. The window is fixed rather than
// sliding: the TTL is set when a counter first appears and the whole count
// expires together, which costs one key per window instead of one per attempt.
// The increment and its expiry run as one script, so no interruption can leave
// a counter that never expires, and any counter found without a TTL anyway
// (one written before that held) is given a fresh window when next counted.
//
// An attempt is counted before it runs, not after it fails: INCR hands every
// concurrent request its own number, so no more than the limit get through
// however many arrive at once. A check followed by recording the failure
// after the password hash would let a parallel burst all pass the check. A
// success then takes its own attempt back -- clearing the account counter and
// refunding the address counter by one -- so what stays counted is failures,
// as before.
//
// The scope keeps each endpoint's budget its own. Sharing them would mean a
// user who re-requested a password reset a few times -- because the first mail
// went to spam -- could not then log in with the password they had just set.
//
// The password change is counted per user rather than per address, on the
// account counter alone: only a session holder reaches it, and one who stole
// the session can change address at will. Keying on the account is safe there
// because only that account's own sessions can spend the budget, and spending
// it blocks only the change form, never login.
export type ThrottleScope =
  | "login"
  | "password-change"
  | "password-reset"
  | "register";

const windowSeconds = 15 * 60;
const accountFailureLimit = 10;
const addressFailureLimit = 50;

// Takes back one counted attempt. A key that expired meanwhile is left
// absent rather than recreated at -1 without a TTL.
const refundScript = `
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then
  redis.call('DECR', KEYS[1])
end
return 0`;

type ThrottleRedis = CounterRedis & {
  del(...keys: string[]): Promise<number>;
};

export class AuthThrottle {
  constructor(private readonly redis: ThrottleRedis) {}

  /**
   * Counts one attempt and says whether it may run. Call it before the work
   * the throttle protects, and `succeeded` once that work proves the caller
   * right; a refused attempt stays counted.
   */
  public async attempt(
    scope: ThrottleScope,
    address: string,
    email: string,
  ): Promise<boolean> {
    const account = await countInWindow(
      this.redis,
      accountKey(scope, address, email),
      windowSeconds,
    );
    if (account.count > accountFailureLimit) return false;
    if (scope === "password-change") return true;
    // Only once the account counter lets it through, so a source grinding a
    // locked account does not also spend its budget for every other one.
    const source = await countInWindow(
      this.redis,
      addressKey(scope, address),
      windowSeconds,
    );
    return source.count <= addressFailureLimit;
  }

  // The account counter clears; the address counter only gets this attempt
  // back. Clearing it would let one valid account reset the budget an
  // attacker is spending against every other account from that address.
  public async succeeded(
    scope: ThrottleScope,
    address: string,
    email: string,
  ): Promise<void> {
    await this.redis.del(accountKey(scope, address, email));
    if (scope === "password-change") return;
    await this.redis.send("EVAL", [
      refundScript,
      "1",
      addressKey(scope, address),
    ]);
  }
}

// The email goes last: an address never contains one, so no pair of inputs
// can produce the same key.
function accountKey(
  scope: ThrottleScope,
  address: string,
  email: string,
): string {
  return `${scope}-fail:${address}:${email}`;
}

function addressKey(scope: ThrottleScope, address: string): string {
  return `${scope}-source:${address}`;
}
