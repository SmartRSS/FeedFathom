import {
  type CounterRedis,
  windowCountLua,
} from "#platform/redis-window-counter.ts";

export type ThrottleScope = "login" | "password-reset" | "register";

const windowSeconds = 15 * 60;
const accountFailureLimit = 10;
const addressFailureLimit = 50;

const attemptScript = `${windowCountLua}
local window = tonumber(ARGV[1])
if KEYS[2] then
  local source = tonumber(redis.call('GET', KEYS[2]) or '0')
  if source > 0 then repairWindow(KEYS[2], window) end
  if source >= tonumber(ARGV[3]) then return 0 end
end
if countInWindow(KEYS[1], window) > tonumber(ARGV[2]) then return 0 end
if KEYS[2] then countInWindow(KEYS[2], window) end
return 1`;

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

  public async attempt(
    scope: ThrottleScope,
    address: string,
    email: string,
  ): Promise<boolean> {
    return await this.count([
      accountKey(scope, address, email),
      addressKey(scope, address),
    ]);
  }

  public async succeeded(
    scope: ThrottleScope,
    address: string,
    email: string,
  ): Promise<void> {
    await this.redis.del(accountKey(scope, address, email));
    await this.redis.send("EVAL", [
      refundScript,
      "1",
      addressKey(scope, address),
    ]);
  }

  public async attemptPasswordChange(userId: number): Promise<boolean> {
    return await this.count([passwordChangeKey(userId)]);
  }

  public async passwordChanged(userId: number): Promise<void> {
    await this.redis.del(passwordChangeKey(userId));
  }

  private async count(keys: string[]): Promise<boolean> {
    const allowed = await this.redis.send("EVAL", [
      attemptScript,
      keys.length.toString(),
      ...keys,
      windowSeconds.toString(),
      accountFailureLimit.toString(),
      addressFailureLimit.toString(),
    ]);
    return allowed === 1;
  }
}

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

function passwordChangeKey(userId: number): string {
  return `password-change-fail:${userId}`;
}
