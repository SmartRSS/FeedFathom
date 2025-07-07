import fs from "node:fs";
import { Agent } from "node:https";
import path from "node:path";
import axios, { type AxiosInstance } from "axios";
import {
  buildStorage,
  type CacheRequestConfig,
  canStale,
  type StorageValue,
  setupCache,
} from "axios-cache-interceptor";
import type { RedisClient } from "bun";
import { logError as error_ } from "../util/log.ts";

const getBuildTime = (): string => {
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
};

const cachedBuildTimestamp = getBuildTime();

export const buildAxios = (redis: RedisClient) => {
  const axiosInstance: AxiosInstance = axios.create({
    headers: {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*",
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": `SmartRSS/FeedFathom ${cachedBuildTimestamp}`,
    },
    httpsAgent: new Agent({
      // increases reliability of data loading from misconfigured servers
      rejectUnauthorized: false,
    }),
    // Enable redirect following with a reasonable limit
    maxRedirects: 5,
    // Add reasonable timeouts to prevent hanging requests
    timeout: 30000, // 30 seconds
  });

  // Default cache duration of 1 minute
  const defaultTtl = 60_000;

  // Fallback cache duration of 30 minutes
  const fallbackTtl = 1_800_000;

  const getRequestTtl = (request: CacheRequestConfig | undefined): number => {
    if (
      request?.cache &&
      typeof request.cache === "object" &&
      typeof request.cache.ttl === "number"
    ) {
      return request.cache.ttl;
    }

    return defaultTtl;
  };

  const calculateCacheTtl = (
    value: StorageValue,
    request: CacheRequestConfig | undefined,
    currentTime: number,
  ): number => {
    if (value.state === "loading") {
      return currentTime + getRequestTtl(request);
    }

    if (value.state === "stale" && value.ttl) {
      return value.createdAt + value.ttl;
    }

    if (value.state === "cached" && !canStale(value)) {
      return value.createdAt + value.ttl;
    }

    return currentTime + fallbackTtl;
  };

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
      const ttl = calculateCacheTtl(value, request, currentTime);
      const validTtl = ttl > currentTime ? ttl - currentTime : fallbackTtl;

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
