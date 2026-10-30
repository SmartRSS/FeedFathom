import { countInWindow } from "#platform/redis-window-counter.ts";

// Failed attempts are counted in Redis and the count gates further ones.
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
// a counter that never expires; any counter found without a TTL anyway (one
// written before that held) is given a fresh window when it is next read or
// counted, since a blocked request never reaches the counting step.
//
// The scope keeps each endpoint's budget its own. Sharing them would mean a
// user who re-requested a password reset a few times -- because the first mail
// went to spam -- could not then log in with the password they had just set.
//
// The password change is counted per user rather than per address: only a
// session holder reaches it, and one who stole the session can change address
// at will. Keying on the account is safe there because only that account's
// own sessions can spend the budget, and spending it blocks only the change
// form, never login.
export type ThrottleScope =
  | "login"
  | "password-change"
  | "password-reset"
  | "register";

const windowSeconds = 15 * 60;
const accountFailureLimit = 10;
const addressFailureLimit = 50;

// TTL -1 means the key exists without an expiry; -2 (absent) is left alone so
// a read never creates a counter.
const readScript = `
local counts = redis.call('MGET', KEYS[1], KEYS[2])
for index, key in ipairs(KEYS) do
  if counts[index] and redis.call('TTL', key) == -1 then
    redis.call('EXPIRE', key, ARGV[1])
  end
end
return counts`;

type ThrottleRedis = {
  del(...keys: string[]): Promise<number>;
  send(command: "EVAL", args: string[]): Promise<unknown>;
};

export class AuthThrottle {
  constructor(private readonly redis: ThrottleRedis) {}

  public async blocked(
    scope: ThrottleScope,
    address: string,
    email: string,
  ): Promise<boolean> {
    const counts = await this.redis.send("EVAL", [
      readScript,
      "2",
      accountKey(scope, address, email),
      addressKey(scope, address),
      windowSeconds.toString(),
    ]);
    const [account, source]: unknown[] = Array.isArray(counts) ? counts : [];
    return (
      Number(account ?? 0) >= accountFailureLimit ||
      Number(source ?? 0) >= addressFailureLimit
    );
  }

  public async recordFailure(
    scope: ThrottleScope,
    address: string,
    email: string,
  ): Promise<void> {
    await Promise.all([
      this.count(accountKey(scope, address, email)),
      this.count(addressKey(scope, address)),
    ]);
  }

  // Only the account counter clears. Leaving the address counter to expire on
  // its own means one valid account cannot be used to reset the budget an
  // attacker is spending against every other account from that address.
  public async clearFailures(
    scope: ThrottleScope,
    address: string,
    email: string,
  ): Promise<void> {
    await this.redis.del(accountKey(scope, address, email));
  }

  private async count(key: string): Promise<void> {
    await countInWindow(this.redis, key, windowSeconds);
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
