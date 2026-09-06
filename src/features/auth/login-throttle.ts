// Failed logins are counted in Redis and the count gates further attempts.
// Two counters, neither keyed on the account alone: an attacker who knows a
// real address must not be able to lock its owner out by guessing at it from
// somewhere else.
//
//   (client address, account) -- one source grinding one account
//   (client address)          -- one source spraying many accounts
//
// A distributed attack on one account is out of reach of both, which is the
// price of not handing anyone a lockout. The window is fixed rather than
// sliding: the TTL is set when a counter first appears and the whole count
// expires together, which costs one key per window instead of one per attempt.
const accountPrefix = "login-fail:";
const addressPrefix = "login-source:";
const windowSeconds = 15 * 60;
const accountFailureLimit = 10;
const addressFailureLimit = 50;

type ThrottleRedis = {
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  incr(key: string): Promise<number>;
  mget(...keys: string[]): Promise<(null | string)[]>;
};

export class LoginThrottle {
  constructor(private readonly redis: ThrottleRedis) {}

  public async blocked(address: string, email: string): Promise<boolean> {
    const [account, source] = await this.redis.mget(
      accountKey(address, email),
      addressKey(address),
    );
    return (
      Number(account ?? 0) >= accountFailureLimit ||
      Number(source ?? 0) >= addressFailureLimit
    );
  }

  public async recordFailure(address: string, email: string): Promise<void> {
    await Promise.all([
      this.count(accountKey(address, email)),
      this.count(addressKey(address)),
    ]);
  }

  // Only the account counter clears. Leaving the address counter to expire on
  // its own means one valid account cannot be used to reset the budget an
  // attacker is spending against every other account from that address.
  public async clearFailures(address: string, email: string): Promise<void> {
    await this.redis.del(accountKey(address, email));
  }

  private async count(key: string): Promise<void> {
    if ((await this.redis.incr(key)) === 1) {
      await this.redis.expire(key, windowSeconds);
    }
  }
}

// The email goes last: an address never contains one, so no pair of inputs
// can produce the same key.
function accountKey(address: string, email: string): string {
  return `${accountPrefix}${address}:${email}`;
}

function addressKey(address: string): string {
  return `${addressPrefix}${address}`;
}
