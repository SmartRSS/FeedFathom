export function requireDisposableRedisUrl(): string {
  const redisUrl = process.env["REDIS_TEST_URL"];
  if (!redisUrl) {
    throw new Error("REDIS_TEST_URL is required");
  }
  const parsed = new URL(redisUrl);
  if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("REDIS_TEST_URL must be a redis: URL with a host");
  }
  const db = decodeURIComponent(parsed.pathname.slice(1));
  const disposable =
    /(?:^|[_-])(?:disposable|test)(?:[_-]|$)/i.test(db) ||
    (/^\d+$/.test(db) && db !== "0") ||
    /(?:^|\.)test(?:\.|:|$)/.test(parsed.hostname);
  if (!disposable) {
    throw new Error(
      "REDIS_TEST_URL must target a database number other than 0, or a hostname or database whose name carries a test or disposable marker",
    );
  }
  return redisUrl;
}
