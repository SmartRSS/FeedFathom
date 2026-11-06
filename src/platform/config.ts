import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";

// Blank is unset: compose.yml passes every variable through as `${X:-}`, so
// the defaults below are the only ones, and an unset variable arrives as "".
const integerString = (
  name: string,
  defaultValue: string | undefined,
  minimum: number,
  maximum: number,
) =>
  Type.Codec(
    Type.String({
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
      pattern: "^\\d*$",
    }),
  )
    .Decode((value) => {
      const parsed = Number(value || defaultValue);
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

const defaultRedisUrl = "redis://redis:6379";
const redisUrl = Type.Codec(Type.String({ default: defaultRedisUrl }))
  .Decode((value) => {
    const url = value || defaultRedisUrl;
    const parsed = new URL(url);
    if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error("REDIS_URL must be a redis: or rediss: URL with a host");
    }
    return url;
  })
  .Encode(String);

const configSchema = Type.Object(
  {
    ALLOWED_EMAILS: Type.Codec(Type.String({ default: "" }))
      .Decode((value) => value.split(",").filter(Boolean))
      .Encode((value) => value.join(",")),
    ENABLE_REGISTRATION: booleanString(),
    WORKER_CONCURRENCY: integerString("WORKER_CONCURRENCY", "25", 1, 128),
    // Per-process Postgres pool size. Matches Bun's SQL default (10), so it is
    // a no-op until sized against max_connections: roughly
    // 1.5 * (APP_REPLICAS + WORKER_REPLICAS) * DB_POOL_MAX. See docs/running.md.
    DB_POOL_MAX: integerString("DB_POOL_MAX", "10", 1, 100),
    // Seconds, as are the two intervals.
    LOCK_DURATION: integerString("LOCK_DURATION", "60", 1, 86_400),
    CLEANUP_INTERVAL: integerString("CLEANUP_INTERVAL", "20", 20, 2_592_000),
    // Days since a user's last request before they count as dormant for
    // article-pruning purposes. 0 disables dormancy-based pruning.
    USER_DORMANT_AFTER_DAYS: integerString(
      "USER_DORMANT_AFTER_DAYS",
      "365",
      0,
      36_500,
    ),
    // Days since last seen in its feed before dormancy alone can prune an
    // article, so something published yesterday survives a dormant subscriber.
    // 0 disables dormancy-based pruning, as does USER_DORMANT_AFTER_DAYS=0.
    ARTICLE_STALE_AFTER_DAYS: integerString(
      "ARTICLE_STALE_AFTER_DAYS",
      "365",
      0,
      36_500,
    ),
    // Days since a user's last request before the account is deleted outright.
    // Measured from the same last-activity timestamp as
    // USER_DORMANT_AFTER_DAYS, which is just an earlier point on that clock,
    // not a separate stateful event. 0 disables account expiry.
    USER_EXPIRY_DAYS: integerString("USER_EXPIRY_DAYS", "730", 0, 36_500),
    DATABASE_URL: databaseUrl,
    // The queue and the HTTP cache. Defaults to the service name in the
    // bundled compose.yml, so a stock deployment needs no value.
    REDIS_URL: redisUrl,
    GATHER_JOBS_INTERVAL: integerString(
      "GATHER_JOBS_INTERVAL",
      "20",
      5,
      86_400,
    ),
    PORT: Type.Optional(integerString("PORT", undefined, 1, 65_535)),
    // A request line is worth a log entry only past this many milliseconds --
    // below it, every request would write one and the slow ones would be
    // lost in the noise.
    SLOW_REQUEST_MS: integerString("SLOW_REQUEST_MS", "500", 1, 600_000),
    MAIL_ENABLED: booleanString(),
    // The host newsletter addresses are minted at, when it differs from
    // FEED_FATHOM_DOMAIN: Cloudflare Email Routing is rarely configured on
    // the host the app is served from. Read through `mailDomain`.
    MAIL_DOMAIN: Type.Optional(Type.String()),
    MAIL_RELAY_SECRET: Type.Optional(Type.String()),
    MAILJET_API_KEY: Type.Optional(Type.String()),
    MAILJET_API_SECRET: Type.Optional(Type.String()),
    // The public host (and port) the app is served at. Read through
    // `publicOrigin`.
    FEED_FATHOM_DOMAIN: Type.Optional(Type.String()),
    // Commit this image was built from, baked in by the Dockerfile rather than
    // supplied by the deployment, so it survives a moving tag. Optional: a
    // local build has no commit to claim.
    FEEDFATHOM_BUILD: Type.Optional(Type.String()),
    // Header carrying the real client address, for deployments that sit
    // behind a proxy (`X-Forwarded-For`, or `CF-Connecting-IP` on Cloudflare).
    // Unset means the socket address is used, which is the right answer when
    // nothing is in front and the only safe one when something is: a header
    // trusted without a proxy to set it is a key the client picks.
    TRUSTED_PROXY_HEADER: Type.Optional(Type.String()),
    TURNSTILE_SITE_KEY: Type.Optional(Type.String()),
    TURNSTILE_SECRET_KEY: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type AppConfig = StaticDecode<typeof configSchema> & {
  // NODE_ENV=production: Secure cookies, the CSP, and serving the built SPA.
  production: boolean;
  // Where mail links point. http only for localhost, whose dev server has no
  // certificate.
  publicOrigin?: URL;
  // The host newsletter addresses are minted at, set only while mail ingest
  // is enabled.
  mailDomain?: string | undefined;
};

// The host addresses are minted at, or undefined unless this deployment
// ingests mail. FEED_FATHOM_DOMAIN is only a fallback for the single-domain
// case: the address host is wherever inbound mail is routed, which is a
// separate deployment decision. Either way it carries the public port for link
// building (localhost:3456 in dev), and an address host never has one.
// First non-blank wins rather than first non-nullish: compose.yml passes
// MAIL_DOMAIN through as `${MAIL_DOMAIN:-}`, so an unset variable arrives as
// "" and a `??` chain would let it shadow the fallback -- which is how
// production silently stopped advertising a newsletter host at all.
function newsletterMailDomain(config: {
  FEED_FATHOM_DOMAIN?: string | undefined;
  MAIL_DOMAIN?: string | undefined;
  MAIL_ENABLED: boolean;
}): string | undefined {
  if (!config.MAIL_ENABLED) return undefined;
  return [config.MAIL_DOMAIN, config.FEED_FATHOM_DOMAIN]
    .map((host) => host?.trim())
    .find(Boolean)
    ?.replace(/:\d+$/u, "");
}

function publicOrigin(domain: string | undefined): URL | undefined {
  const host = domain?.trim();
  if (!host) return undefined;
  const protocol = host.startsWith("localhost") ? "http" : "https";
  return new URL(`${protocol}://${host}`);
}

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
    const origin = publicOrigin(parsed.FEED_FATHOM_DOMAIN);
    if (parsed.MAILJET_API_KEY && parsed.MAILJET_API_SECRET && !origin)
      throw new Error(
        "FEED_FATHOM_DOMAIN is required when Mailjet is configured, for the links mail carries",
      );
    const mailDomain = newsletterMailDomain(parsed);
    return {
      ...parsed,
      ...(mailDomain ? { mailDomain } : {}),
      production: environment["NODE_ENV"] === "production",
      ...(origin ? { publicOrigin: origin } : {}),
    };
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid config: ${details}`, { cause });
  }
}

export const config = loadConfig(process.env);
