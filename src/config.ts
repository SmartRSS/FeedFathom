import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";

const integerString = (
  name: string,
  defaultValue: string | undefined,
  minimum: number,
  maximum: number,
) =>
  Type.Codec(
    Type.String({
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
      pattern: "^\\d+$",
    }),
  )
    .Decode((value) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
        throw new Error(
          `${name} must be an integer from ${minimum} to ${maximum}`,
        );
      return parsed;
    })
    .Encode(String);

const booleanString = (defaultValue = "false") =>
  Type.Codec(Type.String({ default: defaultValue }))
    .Decode((value) => value === "true")
    .Encode(String);

const databaseUrl = Type.Codec(Type.String())
  .Decode((value) => {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname === "/" ||
      !parsed.pathname
    ) {
      throw new Error(
        "DATABASE_URL must be a postgres: or postgresql: URL with a host and database",
      );
    }
    return value;
  })
  .Encode(String);

const configSchema = Type.Object(
  {
    ALLOWED_EMAILS: Type.Codec(Type.String({ default: "" }))
      .Decode((value) => value.split(",").filter(Boolean))
      .Encode((value) => value.join(",")),
    ENABLE_REGISTRATION: booleanString(),
    WORKER_CONCURRENCY: integerString("WORKER_CONCURRENCY", "1", 1, 128),
    // Per-process Postgres connection pool size. Matches Bun's SQL client
    // default (10) so this is a no-op until an operator sizes it against
    // Postgres's own max_connections: roughly
    // 1.5 * (APP_REPLICAS + WORKER_REPLICAS) * DB_POOL_MAX. See
    // docs/running.md.
    DB_POOL_MAX: integerString("DB_POOL_MAX", "10", 1, 100),
    LOCK_DURATION: integerString("LOCK_DURATION", "1000", 1, 86_400),
    CLEANUP_INTERVAL: integerString("CLEANUP_INTERVAL", "1000", 20, 2_592_000),
    DATABASE_URL: databaseUrl,
    GATHER_JOBS_INTERVAL: integerString(
      "GATHER_JOBS_INTERVAL",
      "1000",
      5,
      86_400,
    ),
    PORT: Type.Optional(integerString("PORT", undefined, 1, 65_535)),
    MAIL_ENABLED: booleanString(),
    MAIL_RELAY_SECRET: Type.Optional(Type.String()),
    MAILJET_API_KEY: Type.Optional(Type.String()),
    MAILJET_API_SECRET: Type.Optional(Type.String()),
    FEED_FATHOM_DOMAIN: Type.Optional(Type.String()),
    TURNSTILE_SITE_KEY: Type.Optional(Type.String()),
    TURNSTILE_SECRET_KEY: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type AppConfig = StaticDecode<typeof configSchema>;

export function loadConfig(
  environment: Readonly<Record<string, string | undefined>>,
): AppConfig {
  try {
    const parsed = Value.Decode(configSchema, environment);
    if (parsed.MAIL_ENABLED && !parsed.MAIL_RELAY_SECRET?.trim()) {
      throw new Error(
        "MAIL_RELAY_SECRET is required when MAIL_ENABLED is true",
      );
    }
    if (
      parsed.TURNSTILE_SITE_KEY?.trim() ||
      parsed.TURNSTILE_SECRET_KEY?.trim()
    ) {
      if (
        !parsed.TURNSTILE_SITE_KEY?.trim() ||
        !parsed.TURNSTILE_SECRET_KEY?.trim()
      )
        throw new Error(
          "TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must both be configured",
        );
    }
    return parsed;
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid config: ${details}`, { cause });
  }
}

export const config = loadConfig(process.env);
