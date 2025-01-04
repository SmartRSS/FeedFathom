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

const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";

const browserUasOrigins: string[] = [];

const cachedBuildTimestamp = fs.readFileSync("/app/BUILD_TIME", "utf-8").trim();

export const buildAxios = (redis: Redis) => {
  const axiosInstance: AxiosInstance = Axios.create({
    headers: { "Accept-Encoding": "gzip, deflate" },
    httpsAgent: new https.Agent({
      rejectUnauthorized: false, // increases reliability of data loading from misconfigured servers
    }),
  });

  axiosInstance.interceptors.request.use((config) => {
    if (!config.url) {
      return config;
    }
    try {
      const url = new URL(config.url);
      if (browserUasOrigins.includes(url.origin)) {
        config.headers?.setUserAgent(browserUserAgent);
      } else {
        config.headers?.setUserAgent(
          `SmartRSS/FeedFathom ${cachedBuildTimestamp}`,
        );
      }

      return config;
    } catch {
      return config;
    }
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
      const ttl =
        value.state === "loading"
          ? Date.now() +
            (req?.cache && typeof req.cache.ttl === "number"
              ? req.cache.ttl
              : 60000)
          : (value.state === "stale" && value.ttl) ||
              (value.state === "cached" && !canStale(value))
            ? value.createdAt + value.ttl!
            : undefined;

      if (ttl) {
        await redis.set(
          `axios-cache-${key}`,
          JSON.stringify(value),
          "PX",
          ttl - Date.now(),
        );
      } else {
        await redis.set(`axios-cache-${key}`, JSON.stringify(value));
      }
    },
    async remove(key) {
      await redis.del(`axios-cache-${key}`);
    },
  });

  return setupCache(axiosInstance, {
    storage: redisStorage,
  });
};
