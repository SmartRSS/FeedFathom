import { logError as error_ } from "../util/log";
import Axios, { type AxiosInstance } from "axios";
import {
  buildStorage,
  canStale,
  setupCache,
  type StorageValue,
} from "axios-cache-interceptor";
import type Redis from "ioredis";
import fs from "node:fs";
import * as https from "node:https";
import path from "path";

function getBuildTime(): string {
  const buildTimePath = path.join(process.cwd(), "BUILD_TIME");

  try {
    if (fs.existsSync(buildTimePath)) {
      return fs.readFileSync(buildTimePath, "utf8").trim();
    }

    // If file doesn't exist, return current timestamp for development
    return Date.now().toString();
  } catch (error) {
    error_("Error reading BUILD_TIME, using current timestamp:", error);
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
    async remove(key) {
      await redis.del(`axios-cache-${key}`);
    },
    async set(key, value, request) {
      const currentTime = Date.now();
      const ttl =
        value.state === "loading"
          ? currentTime +
            (request?.cache && typeof request.cache.ttl === "number"
              ? request.cache.ttl
              : 60_000)
          : (value.state === "stale" && value.ttl) ||
              (value.state === "cached" && !canStale(value))
            ? value.createdAt + value.ttl!
            : undefined;

      const validTtl = ttl && ttl > currentTime ? ttl - currentTime : 1_800_000;

      await redis.set(
        `axios-cache-${key}`,
        JSON.stringify(value),
        "PX",
        validTtl,
      );
    },
  });

  return setupCache(axiosInstance, {
    storage: redisStorage,
  });
};
