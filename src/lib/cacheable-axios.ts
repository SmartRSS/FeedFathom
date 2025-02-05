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

const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";

const browserUasOrigins: string[] = [];

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

// Add a constant for maximum retries
const MAX_RETRIES = 1;

export const buildAxios = (redis: Redis) => {
  const axiosInstance: AxiosInstance = Axios.create({
    headers: { "Accept-Encoding": "gzip, deflate" },
    httpsAgent: new https.Agent({
      rejectUnauthorized: false, // increases reliability of data loading from misconfigured servers
    }),
  });

  axiosInstance.interceptors.request.use(async (config) => {
    if (!config.url) {
      return config;
    }
    try {
      const url = new URL(config.url);
      if (browserUasOrigins.includes(url.origin)) {
        config.headers['User-Agent'] = browserUserAgent; // Set User-Agent
      } else {
        config.headers['User-Agent'] = `SmartRSS/FeedFathom ${cachedBuildTimestamp}`;
      }

      return config;
    } catch {
      return config;
    }
  }, async (error) => {
    const config = error.config;
    const originalUserAgent = config.headers['User-Agent'];

    // Check if the request was not already using the browser User-Agent
    if (error.code === 'ECONNREFUSED' && originalUserAgent !== browserUserAgent && config.__retryCount < MAX_RETRIES) {
      config.__retryCount = config.__retryCount || 0;
      config.__retryCount += 1;

      await Bun.sleep(2000); // Wait for 2 seconds before retrying
      config.headers['User-Agent'] = browserUserAgent; // Set to browser User-Agent

      const response = await axiosInstance.request(config); // Retry the request

      // Check the response status
      if (response.status >= 200 && response.status < 400) {
        // Update the browserUasOrigins array if the request succeeds
        const url = new URL(config.url);
        if (!browserUasOrigins.includes(url.origin)) {
          browserUasOrigins.push(url.origin);
        }
        return response; // Return the successful response
      } else {
        return Promise.reject(new Error(`Request failed with status ${response.status}`));
      }
    }
    return Promise.reject(error);
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
