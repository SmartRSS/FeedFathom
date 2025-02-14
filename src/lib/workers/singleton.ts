import type Redis from "ioredis";

export type SingletonJobConfig = {
  delayMs: number;
  key: string;
}

export class SingletonJobHandler {
  constructor(private readonly redis: Redis) {}

  async runSingleton<T>(
    config: SingletonJobConfig,
    job: () => Promise<T>,
  ): Promise<null | T> {
    const lock = await this.redis.set(
      `singleton-job-lock:${config.key}`,
      "locked",
      "EX",
      Math.floor(config.delayMs / 1_000),
      "NX",
    );

    if (!lock) {
      return null;
    }

    return job();
  }
}
