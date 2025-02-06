import type Redis from "ioredis";

export interface SingletonJobConfig {
  key: string;
  delayMs: number;
}

export class SingletonJobHandler {
  constructor(private readonly redis: Redis) {}

  async runSingleton<T>(
    config: SingletonJobConfig,
    job: () => Promise<T>,
  ): Promise<T | null> {
    const lock = await this.redis.set(
      `singleton-job-lock:${config.key}`,
      "locked",
      "EX",
      Math.floor(config.delayMs / 1000),
      "NX",
    );

    if (!lock) {
      return null;
    }
    return job();
  }
}
