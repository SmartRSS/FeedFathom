/** biome-ignore-all lint/style/useNamingConvention: ENV access */
import { type } from "arktype";

const configSchema = type({
  ALLOWED_EMAILS: type("string")
    .pipe((s) => s.split(",").filter(Boolean))
    .default(""),

  ENABLE_REGISTRATION: type("string")
    .pipe((s) => s === "true")
    .default("false"),

  WORKER_CONCURRENCY: type("string.numeric.parse").default("1"),

  LOCK_DURATION: type("string.numeric.parse").default("1000"),

  CLEANUP_INTERVAL: type("string.numeric.parse").default("1000"),

  GATHER_JOBS_INTERVAL: type("string.numeric.parse").default("1000"),

  APP_REPLICAS: type("string.numeric.parse").default("1"),

  MAIL_ENABLED: type("string")
    .pipe((s) => s === "true")
    .default("false"),
  "INTEGRATION?": "'mail'|'migrator'|'worker'",
  "MAILJET_API_KEY?": "string",
  "MAILJET_API_SECRET?": "string",
  "FEED_FATHOM_DOMAIN?": "string",
  "TURNSTILE_SITE_KEY?": "string",
  "TURNSTILE_SECRET_KEY?": "string",
  "+": "delete",
});

type AppConfig = typeof configSchema.infer;

function assertConfig(
  value: AppConfig | type.errors,
): asserts value is AppConfig {
  if (value instanceof type.errors) {
    throw new Error(`Invalid config: ${value.summary}`);
  }
}

const rawConfig = configSchema(process.env);
assertConfig(rawConfig);

export type { AppConfig };
export const config = rawConfig satisfies AppConfig;
