import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

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
      CLEANUP_INTERVAL: 1000,
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: 10,
      ENABLE_REGISTRATION: false,
      GATHER_JOBS_INTERVAL: 1000,
      LOCK_DURATION: 1000,
      MAIL_ENABLED: false,
      WORKER_CONCURRENCY: 1,
    });
  });

  test("transforms configured strings", () => {
    expect(
      loadConfig({
        ALLOWED_EMAILS: "one@example.com,,two@example.com",
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

  test("allows mail when the relay secret is present", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        MAIL_ENABLED: "true",
        MAIL_RELAY_SECRET: "relay-secret",
      }).MAIL_RELAY_SECRET,
    ).toBe("relay-secret");
  });

  test("allows blank Turnstile keys to disable Turnstile", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        TURNSTILE_SECRET_KEY: "",
        TURNSTILE_SITE_KEY: "",
      }),
    ).toMatchObject({
      TURNSTILE_SECRET_KEY: "",
      TURNSTILE_SITE_KEY: "",
    });
  });

  test("accepts paired Turnstile keys", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        TURNSTILE_SECRET_KEY: "secret",
        TURNSTILE_SITE_KEY: "site",
      }),
    ).toMatchObject({
      TURNSTILE_SECRET_KEY: "secret",
      TURNSTILE_SITE_KEY: "site",
    });
  });

  test.each([
    { TURNSTILE_SITE_KEY: "site" },
    { TURNSTILE_SECRET_KEY: "secret" },
    { TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "secret" },
    { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "   " },
  ])("rejects incomplete Turnstile configuration %#", (environment) => {
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, ...environment }),
    ).toThrow(
      "TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must both be configured",
    );
  });

  test("rejects invalid numeric values", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, WORKER_CONCURRENCY: "many" }),
    ).toThrow("Invalid config");
  });
});
