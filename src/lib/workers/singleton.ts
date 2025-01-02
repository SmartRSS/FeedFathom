import type Redis from "ioredis";
import { llog } from "../../util/log";

export interface SingletonJobConfig {
  key: string;
  delayMs: number;
}

export class SingletonJobHandler {
  constructor(private readonly redis: Redis) {}

  async runSingleton<T>(
    config: SingletonJobConfig,
    job: () => Promise<T>
  ): Promise<T | null> {
    const lock = await this.redis.set(
      `singleton-job-lock:${config.key}`,
      'locked',
      'EX',
      Math.floor(config.delayMs / 1000)
    );

    if (!lock) {
      llog(`Singleton job ${config.key} skipped - another instance is running or cooldown period`);
      return null;
    }

    try {
      const result = await job();
      return result;
    } finally {
      // Ensure minimum delay between jobs
      await new Promise(resolve => setTimeout(resolve, config.delayMs));
    }
  }
}
