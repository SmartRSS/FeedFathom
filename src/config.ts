import { type } from "arktype";

const configSchema = type({
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  ALLOWED_EMAILS: type("string")
    .pipe((s) => s.split(",").filter(Boolean))
    .default(""),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  ENABLE_REGISTRATION: type("string")
    .pipe((s) => s === "true")
    .default("false"),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  WORKER_CONCURRENCY: type("string.numeric.parse").default("1"),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  LOCK_DURATION: type("string.numeric.parse").default("1000"),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  CLEANUP_INTERVAL: type("string.numeric.parse").default("1000"),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  GATHER_JOBS_INTERVAL: type("string.numeric.parse").default("1000"),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  APP_REPLICAS: type("string.numeric.parse").default("1"),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  MAIL_ENABLED: type("string")
    .pipe((s) => s === "true")
    .default("false"),
  "INTEGRATION?": "'mail'|'migrator'|'worker'",
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  "MAILJET_API_KEY?": "string",
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  "MAILJET_API_SECRET?": "string",
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  "FEED_FATHOM_DOMAIN?": "string",
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  "TURNSTILE_SITE_KEY?": "string",
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
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
