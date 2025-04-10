import type { RedisClient } from "bun";

interface GetExOptions {
  EX?: number;
  PX?: number;
  EXAT?: number;
  PXAT?: number;
  PERSIST?: boolean;
}

// Mock Redis client for build process
export class MockRedisClient implements RedisClient {
  connected = false;
  bufferedAmount = 0;
  onconnect = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  onping = null;
  onpong = null;
  onreconnecting = null;
  onready = null;
  onend = null;
  onunsubscribe = null;
  onsubscribe = null;
  onpsubscribe = null;
  onpunsubscribe = null;
  onpmessage = null;
  onpmessageb = null;
  onpmessagec = null;
  onpmessaged = null;
  onpmessagee = null;
  onpmessagef = null;
  onpmessageg = null;
  onpmessageh = null;
  onpmessagei = null;
  onpmessagej = null;
  onpmessagek = null;
  onpmessagel = null;
  onpmessagem = null;
  onpmessagen = null;
  onpmessageo = null;
  onpmessagep = null;
  onpmessageq = null;
  onpmessager = null;
  onpmessages = null;
  onpmessaget = null;
  onpmessageu = null;
  onpmessagev = null;
  onpmessagew = null;
  onpmessagex = null;
  onpmessagey = null;
  onpmessagez = null;

  async connect() {
    this.connected = true;
    return await Promise.resolve();
  }

  async disconnect() {
    this.connected = false;
    return await Promise.resolve();
  }

  async get() {
    return await Promise.resolve(null);
  }

  async set(
    _key: string | ArrayBufferView | Blob,
    _value: string | ArrayBufferView | Blob,
  ): Promise<"OK">;
  async set(
    _key: string | ArrayBufferView | Blob,
    _value: string | ArrayBufferView | Blob,
    _ex: "EX",
    _seconds: number,
  ): Promise<"OK">;
  async set(
    _key: string | ArrayBufferView | Blob,
    _value: string | ArrayBufferView | Blob,
    _px: "PX",
    _milliseconds: number,
  ): Promise<"OK">;
  async set(
    _key: string | ArrayBufferView | Blob,
    _value: string | ArrayBufferView | Blob,
    _ex?: "EX" | "PX",
    _time?: number,
  ): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async lpush(
    _key: string | ArrayBufferView | Blob,
    ..._elements: (string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async rpop(_key: string | ArrayBufferView | Blob): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async sismember(
    _key: string | ArrayBufferView | Blob,
    _member: string,
  ): Promise<boolean> {
    return await Promise.resolve(false);
  }

  async sadd(
    _key: string | ArrayBufferView | Blob,
    ..._members: (string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async srem(
    _key: string | ArrayBufferView | Blob,
    _member: string,
  ): Promise<number> {
    return await Promise.resolve(1);
  }

  async del(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(1);
  }

  async ping() {
    return await Promise.resolve("PONG");
  }

  async close(): Promise<void> {
    return await Promise.resolve();
  }

  async send(_command: string, _args: string[]): Promise<unknown> {
    return await Promise.resolve(null);
  }

  async incr(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(1);
  }

  async decr(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(0);
  }

  async expire(
    _key: string | ArrayBufferView | Blob,
    _seconds: number,
  ): Promise<number> {
    return await Promise.resolve(1);
  }

  async ttl(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(-1);
  }

  async exists(_key: string | ArrayBufferView | Blob): Promise<boolean> {
    return await Promise.resolve(false);
  }

  async keys(_pattern: string): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async flushall(): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async flushdb(): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async quit(): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async select(_db: number): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async bgrewriteaof(): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async bgsave(): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  // biome-ignore lint/style/useNamingConvention: <explanation>
  async config_get(_parameter: string): Promise<Record<string, string>> {
    return await Promise.resolve({});
  }

  // biome-ignore lint/style/useNamingConvention: <explanation>
  async config_set(_parameter: string, _value: string): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async dbsize(): Promise<number> {
    return await Promise.resolve(0);
  }

  // biome-ignore lint/style/useNamingConvention: <explanation>
  async debug_object(_key: string): Promise<string> {
    return await Promise.resolve("");
  }

  // biome-ignore lint/style/useNamingConvention: <explanation>
  async debug_segfault(): Promise<never> {
    return await Promise.reject(new Error("Not implemented"));
  }

  async flushallAsync(): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async flushdbAsync(): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async info(_section?: string): Promise<string> {
    return await Promise.resolve("");
  }

  async lastsave(): Promise<number> {
    return await Promise.resolve(0);
  }

  async monitor(): Promise<never> {
    return await Promise.reject(new Error("Not implemented"));
  }

  async move(_key: string, _db: number): Promise<number> {
    return await Promise.resolve(0);
  }

  async object(_subcommand: string, _key: string): Promise<unknown> {
    return await Promise.resolve(null);
  }

  async randomkey(): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async save(): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async shutdown(): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async slaveof(_host: string, _port: number): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async slowlog(_subcommand: string, ..._args: string[]): Promise<unknown> {
    return await Promise.resolve(null);
  }

  async sync(): Promise<never> {
    return await Promise.reject(new Error("Not implemented"));
  }

  async time(): Promise<[string, string]> {
    return await Promise.resolve(["0", "0"]);
  }

  async hmset(
    _key: string | ArrayBufferView | Blob,
    _fieldValues: string[],
  ): Promise<string> {
    return await Promise.resolve("OK");
  }

  async hmget(
    _key: string | ArrayBufferView | Blob,
    _fields: string[],
  ): Promise<(string | null)[]> {
    return await Promise.resolve([]);
  }

  async srandmember(
    _key: string | ArrayBufferView | Blob,
  ): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async spop(_key: string | ArrayBufferView | Blob): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async hincrby(
    _key: string | ArrayBufferView | Blob,
    _field: string,
    _increment: number,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async hincrbyfloat(
    _key: string | ArrayBufferView | Blob,
    _field: string,
    _increment: number,
  ): Promise<string> {
    return await Promise.resolve("0");
  }

  async hgetall(
    _key: string | ArrayBufferView | Blob,
  ): Promise<Record<string, string>> {
    return await Promise.resolve({});
  }

  async hkeys(_key: string | ArrayBufferView | Blob): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async hlen(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(0);
  }

  async hset(
    _key: string | ArrayBufferView | Blob,
    _field: string,
    _value: string,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async hsetnx(
    _key: string | ArrayBufferView | Blob,
    _field: string,
    _value: string,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async hvals(_key: string | ArrayBufferView | Blob): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async hscan(
    _key: string | ArrayBufferView | Blob,
    _cursor: number,
    _options?: { match?: string; count?: number },
  ): Promise<[string, string[]]> {
    return await Promise.resolve(["0", []]);
  }

  async hdel(
    _key: string | ArrayBufferView | Blob,
    ..._fields: string[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async hexists(
    _key: string | ArrayBufferView | Blob,
    _field: string,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async hget(
    _key: string | ArrayBufferView | Blob,
    _field: string,
  ): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async hstrlen(
    _key: string | ArrayBufferView | Blob,
    _field: string,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async smembers(_key: string | ArrayBufferView | Blob): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async llen(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(0);
  }

  async lpop(_key: string | ArrayBufferView | Blob): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async persist(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(0);
  }

  async lrange(
    _key: string | ArrayBufferView | Blob,
    _start: number,
    _stop: number,
  ): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async lrem(
    _key: string | ArrayBufferView | Blob,
    _count: number,
    _value: string,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async lset(
    _key: string | ArrayBufferView | Blob,
    _index: number,
    _value: string,
  ): Promise<string> {
    return await Promise.resolve("OK");
  }

  async ltrim(
    _key: string | ArrayBufferView | Blob,
    _start: number,
    _stop: number,
  ): Promise<string> {
    return await Promise.resolve("OK");
  }

  async rpush(
    _key: string | ArrayBufferView | Blob,
    ..._values: string[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async scard(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(0);
  }

  async sdiff(
    ..._keys: (string | ArrayBufferView | Blob)[]
  ): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async sinter(
    ..._keys: (string | ArrayBufferView | Blob)[]
  ): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async smove(
    _source: string | ArrayBufferView | Blob,
    _destination: string | ArrayBufferView | Blob,
    _member: string,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async sunion(
    ..._keys: (string | ArrayBufferView | Blob)[]
  ): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async zadd(
    _key: string | ArrayBufferView | Blob,
    ..._args: (number | string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async zcard(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(0);
  }

  async zcount(
    _key: string | ArrayBufferView | Blob,
    _min: number | string,
    _max: number | string,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async zincrby(
    _key: string | ArrayBufferView | Blob,
    _increment: number,
    _member: string,
  ): Promise<string> {
    return await Promise.resolve("0");
  }

  async zrange(
    _key: string | ArrayBufferView | Blob,
    _start: number,
    _stop: number,
    _withscores?: "WITHSCORES",
  ): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async zrank(
    _key: string | ArrayBufferView | Blob,
    _member: string,
  ): Promise<number | null> {
    return await Promise.resolve(null);
  }

  async zrem(
    _key: string | ArrayBufferView | Blob,
    ..._members: string[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async zscore(
    _key: string | ArrayBufferView | Blob,
    _member: string,
  ): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async pexpiretime(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(-1);
  }

  async pttl(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(-1);
  }

  async strlen(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(0);
  }

  async zpopmax(
    _key: string | ArrayBufferView | Blob,
    _count?: number,
  ): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async zpopmin(
    _key: string | ArrayBufferView | Blob,
    _count?: number,
  ): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async zrevrange(
    _key: string | ArrayBufferView | Blob,
    _start: number,
    _stop: number,
    _withscores?: "WITHSCORES",
  ): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async zrevrank(
    _key: string | ArrayBufferView | Blob,
    _member: string,
  ): Promise<number | null> {
    return await Promise.resolve(null);
  }

  async zrevrangebyscore(
    _key: string | ArrayBufferView | Blob,
    _max: number | string,
    _min: number | string,
    _withscores?: "WITHSCORES",
    _limit?: [number, number],
  ): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async zrangebyscore(
    _key: string | ArrayBufferView | Blob,
    _min: number | string,
    _max: number | string,
    _withscores?: "WITHSCORES",
    _limit?: [number, number],
  ): Promise<string[]> {
    return await Promise.resolve([]);
  }

  async zremrangebyrank(
    _key: string | ArrayBufferView | Blob,
    _start: number,
    _stop: number,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async zremrangebyscore(
    _key: string | ArrayBufferView | Blob,
    _min: number | string,
    _max: number | string,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async zunionstore(
    _destination: string | ArrayBufferView | Blob,
    _numkeys: number,
    ..._keys: (string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async zinterstore(
    _destination: string | ArrayBufferView | Blob,
    _numkeys: number,
    ..._keys: (string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async zrandmember(
    _key: string | ArrayBufferView | Blob,
  ): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async append(
    _key: string | ArrayBufferView | Blob,
    _value: string | ArrayBufferView | Blob,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async getset(
    _key: string | ArrayBufferView | Blob,
    _value: string | ArrayBufferView | Blob,
  ): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async lpushx(
    _key: string | ArrayBufferView | Blob,
    ..._values: (string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async rpushx(
    _key: string | ArrayBufferView | Blob,
    ..._values: (string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async setex(
    _key: string | ArrayBufferView | Blob,
    _seconds: number,
    _value: string | ArrayBufferView | Blob,
  ): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async setnx(
    _key: string | ArrayBufferView | Blob,
    _value: string | ArrayBufferView | Blob,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async msetnx(
    ..._keyValues: (string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async psetex(
    _key: string | ArrayBufferView | Blob,
    _milliseconds: number,
    _value: string | ArrayBufferView | Blob,
  ): Promise<"OK"> {
    return await Promise.resolve("OK");
  }

  async setrange(
    _key: string | ArrayBufferView | Blob,
    _offset: number,
    _value: string | ArrayBufferView | Blob,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async getrange(
    _key: string | ArrayBufferView | Blob,
    _start: number,
    _end: number,
  ): Promise<string> {
    return await Promise.resolve("");
  }

  async bitcount(
    _key: string | ArrayBufferView | Blob,
    _start?: number,
    _end?: number,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async bitpos(
    _key: string | ArrayBufferView | Blob,
    _bit: 0 | 1,
    _start?: number,
    _end?: number,
  ): Promise<number> {
    return await Promise.resolve(-1);
  }

  async bitfield(
    _key: string | ArrayBufferView | Blob,
    ..._operations: string[]
  ): Promise<(number | null)[]> {
    return await Promise.resolve([]);
  }

  async bitop(
    _operation: "AND" | "OR" | "XOR" | "NOT",
    _destkey: string | ArrayBufferView | Blob,
    ..._keys: (string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async getbit(
    _key: string | ArrayBufferView | Blob,
    _offset: number,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async setbit(
    _key: string | ArrayBufferView | Blob,
    _offset: number,
    _value: 0 | 1,
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async pfadd(
    _key: string | ArrayBufferView | Blob,
    ..._elements: (string | ArrayBufferView | Blob)[]
  ): Promise<number> {
    return await Promise.resolve(0);
  }

  async mget(
    ..._keys: (string | ArrayBufferView | Blob)[]
  ): Promise<(string | null)[]> {
    return await Promise.resolve([]);
  }

  async dump(_key: string | ArrayBufferView | Blob): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async expiretime(_key: string | ArrayBufferView | Blob): Promise<number> {
    return await Promise.resolve(-1);
  }

  async touch(..._keys: (string | ArrayBufferView | Blob)[]): Promise<number> {
    return await Promise.resolve(0);
  }

  async getdel(_key: string | ArrayBufferView | Blob): Promise<string | null> {
    return await Promise.resolve(null);
  }

  async getex(
    _key: string | ArrayBufferView | Blob,
    _options?: GetExOptions,
  ): Promise<string | null> {
    return await Promise.resolve(null);
  }
}
