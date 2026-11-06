import { describe, expect, test } from "bun:test";
import { loadConfig } from "#platform/config.ts";

const databaseUrl =
  "postgresql://feedfathom:secret@db.example.com:5432/feedfathom";

describe("loadConfig", () => {
  test("applies defaults and removes unrelated environment values", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        PATH: "/usr/bin",
        UNUSED: "value",
      }),
    ).toEqual({
      ALLOWED_EMAILS: [],
      ARTICLE_STALE_AFTER_DAYS: 365,
      CLEANUP_INTERVAL: 20,
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: 10,
      ENABLE_REGISTRATION: false,
      GATHER_JOBS_INTERVAL: 20,
      LOCK_DURATION: 60,
      MAIL_ENABLED: false,
      REDIS_URL: "redis://redis:6379",
      SLOW_REQUEST_MS: 500,
      USER_DORMANT_AFTER_DAYS: 365,
      USER_EXPIRY_DAYS: 730,
      WORKER_CONCURRENCY: 25,
      production: false,
    });
  });

  test("transforms configured strings", () => {
    expect(
      loadConfig({
        ALLOWED_EMAILS: "one@example.com,, two@example.com ",
        CLEANUP_INTERVAL: "20",
        DATABASE_URL: databaseUrl,
        DB_POOL_MAX: "3",
        ENABLE_REGISTRATION: "true",
        GATHER_JOBS_INTERVAL: "6",
        LOCK_DURATION: "7",
        MAIL_ENABLED: "true",
        MAIL_RELAY_SECRET: "relay-secret",
        WORKER_CONCURRENCY: "8",
      }),
    ).toMatchObject({
      ALLOWED_EMAILS: ["one@example.com", "two@example.com"],
      CLEANUP_INTERVAL: 20,
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: 3,
      ENABLE_REGISTRATION: true,
      GATHER_JOBS_INTERVAL: 6,
      LOCK_DURATION: 7,
      MAIL_ENABLED: true,
      MAIL_RELAY_SECRET: "relay-secret",
      WORKER_CONCURRENCY: 8,
    });
  });

  test("requires a database URL", () => {
    expect(() => loadConfig({})).toThrow("Invalid config");
  });

  test.each([
    "https://db.example.com/feedfathom",
    "postgresql:///feedfathom",
    "postgresql://db.example.com",
    "not a URL",
  ])("rejects invalid database URL %s", (value) => {
    expect(() => loadConfig({ DATABASE_URL: value })).toThrow("Invalid config");
  });

  test.each(["postgres:", "postgresql:"])(
    "accepts the %s protocol",
    (protocol) => {
      const value = `${protocol}//db.example.com/feedfathom`;
      expect(loadConfig({ DATABASE_URL: value }).DATABASE_URL).toBe(value);
    },
  );

  test.each(["http://cache.example.com", "redis://", "not a URL"])(
    "rejects invalid Redis URL %s",
    (value) => {
      expect(() =>
        loadConfig({ DATABASE_URL: databaseUrl, REDIS_URL: value }),
      ).toThrow("Invalid config");
    },
  );

  test.each(["redis:", "rediss:"])(
    "accepts the %s protocol for Redis",
    (protocol) => {
      const value = `${protocol}//cache.example.com:6379`;
      expect(
        loadConfig({ DATABASE_URL: databaseUrl, REDIS_URL: value }).REDIS_URL,
      ).toBe(value);
    },
  );

  test.each([undefined, "", "   "])(
    "requires a non-blank mail relay secret when mail is enabled",
    (secret) => {
      expect(() =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          MAIL_ENABLED: "true",
          MAIL_RELAY_SECRET: secret,
        }),
      ).toThrow("Invalid config");
    },
  );

  test.each([
    ["both blank (off)", "", ""],
    ["both set", "secret", "site"],
  ])("accepts Turnstile keys that are %s", (_case, secret, site) => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        TURNSTILE_SECRET_KEY: secret,
        TURNSTILE_SITE_KEY: site,
      }),
    ).toMatchObject({
      TURNSTILE_SECRET_KEY: secret,
      TURNSTILE_SITE_KEY: site,
    });
  });

  test.each([
    { TURNSTILE_SITE_KEY: "site" },
    { TURNSTILE_SECRET_KEY: "secret" },
    { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_SITE_KEY: "" },
    { TURNSTILE_SECRET_KEY: "   ", TURNSTILE_SITE_KEY: "site" },
  ])("rejects incomplete Turnstile configuration %#", (environment) => {
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, ...environment }),
    ).toThrow(
      "TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must both be configured",
    );
  });

  // compose.yml passes every variable through as ${X:-}.
  test("treats a blank value as unset", () => {
    const defaults = loadConfig({ DATABASE_URL: databaseUrl });
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        DB_POOL_MAX: "",
        REDIS_URL: "",
        WORKER_CONCURRENCY: "",
      }),
    ).toEqual(defaults);
  });

  test("production follows NODE_ENV", () => {
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "production" })
        .production,
    ).toBe(true);
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "development" })
        .production,
    ).toBe(false);
  });

  test.each([
    ["localhost:3456", "http://localhost:3456"],
    ["127.0.0.1:3456", "http://127.0.0.1:3456"],
    ["localhost.example.com", "https://localhost.example.com"],
    ["feeds.example.com", "https://feeds.example.com"],
    ["feeds.example.com:8443", "https://feeds.example.com:8443"],
  ])("serves %s at %s", (domain, origin) => {
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, FEED_FATHOM_DOMAIN: domain })
        .publicOrigin?.origin,
    ).toBe(origin);
  });

  test("refuses Mailjet credentials with no public origin to link to", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        MAILJET_API_KEY: "key",
        MAILJET_API_SECRET: "secret",
      }),
    ).toThrow("FEED_FATHOM_DOMAIN is required");
  });

  // MAIL_DOMAIN is where inbound mail is routed and FEED_FATHOM_DOMAIN is
  // where the app is served; they coincide only in single-domain setups, so
  // the app host is a fallback and never an override.
  test.each([
    ["false", "feeds.example.com", undefined, undefined],
    ["true", "", undefined, undefined],
    ["true", "feeds.example.com:8443", undefined, "feeds.example.com"],
    ["true", "app.example.com", "mail.example.com", "mail.example.com"],
    // Blank is unset, not an override: compose.yml always defines MAIL_DOMAIN.
    ["true", "app.example.com", "", "app.example.com"],
    ["true", "", "", undefined],
  ])(
    "mints newsletter addresses only with mail enabled (%p, %p, %p)",
    (mailEnabled, domain, mailDomain, expected) => {
      expect(
        loadConfig({
          DATABASE_URL: databaseUrl,
          FEED_FATHOM_DOMAIN: domain,
          MAIL_DOMAIN: mailDomain,
          MAIL_ENABLED: mailEnabled,
          MAIL_RELAY_SECRET: "relay-secret",
        }).mailDomain,
      ).toBe(expected);
    },
  );

  test("rejects invalid numeric values", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, WORKER_CONCURRENCY: "many" }),
    ).toThrow("Invalid config");
  });
});
