import Axios, { type AxiosInstance } from "axios";
import * as https from "node:https";
import {
  buildStorage,
  canStale,
  setupCache,
  type StorageValue,
} from "axios-cache-interceptor";
import Redis from "ioredis";
import fs from "node:fs";
import path from "path";
import { err } from "../util/log";

function getBuildTime(): string {
  const buildTimePath = path.join(process.cwd(), "BUILD_TIME");

  try {
    if (fs.existsSync(buildTimePath)) {
      return fs.readFileSync(buildTimePath, "utf-8").trim();
    }
    // If file doesn't exist, return current timestamp for development
    return Date.now().toString();
  } catch (error) {
    err("Error reading BUILD_TIME, using current timestamp:", error);
    return Date.now().toString();
  }
}

const cachedBuildTimestamp = getBuildTime();

export const buildAxios = (redis: Redis) => {
  const axiosInstance: AxiosInstance = Axios.create({
    headers: {
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": `SmartRSS/FeedFathom ${cachedBuildTimestamp}`,
    },
    httpsAgent: new https.Agent({
      // increases reliability of data loading from misconfigured servers
      rejectUnauthorized: false,
    }),
  });

  const redisStorage = buildStorage({
    async find(key) {
      const cachedValue = await redis.get(`axios-cache-${key}`);
      if (!cachedValue) {
        return undefined;
      }
      return JSON.parse(cachedValue) as StorageValue;
    },
    async set(key, value, req) {
      const currentTime = Date.now();
      const ttl =
        value.state === "loading"
          ? currentTime +
            (req?.cache && typeof req.cache.ttl === "number"
              ? req.cache.ttl
              : 60000)
          : (value.state === "stale" && value.ttl) ||
              (value.state === "cached" && !canStale(value))
            ? value.createdAt + value.ttl!
            : undefined;

      const validTtl = ttl && ttl > currentTime ? ttl - currentTime : 1800000;

      await redis.set(
        `axios-cache-${key}`,
        JSON.stringify(value),
        "PX",
        validTtl,
      );
    },
    async remove(key) {
      await redis.del(`axios-cache-${key}`);
    },
  });

  return setupCache(axiosInstance, {
    storage: redisStorage,
  });
};
