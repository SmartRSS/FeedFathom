import { type } from "arktype";

const configSchema = type({
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  ALLOWED_EMAILS: type("string").pipe((s) => s.split(",").filter(Boolean)),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  ENABLE_REGISTRATION: type("string").pipe((s) => s === "true"),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  WORKER_CONCURRENCY: type("string.numeric.parse"),
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  LOCK_DURATION: "string.numeric.parse",
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  CLEANUP_INTERVAL: "string.numeric.parse",
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  GATHER_JOBS_INTERVAL: "string.numeric.parse",
  // biome-ignore lint/style/useNamingConvention: environment variables are in uppercase
  APP_REPLICAS: "string.numeric.parse",
  "INTEGRATION?": "'mail'|'migrator'|'worker'",
  "+": "delete",
});

type Config = typeof configSchema.infer;
function assertConfig(value: Config | type.errors): asserts value is Config {
  if (value instanceof type.errors) {
    throw new Error(`Invalid config: ${value.summary}`);
  }
}

function createConfig(): Config {
  const result = configSchema(process.env);
  assertConfig(result);
  return result;
}

const config = createConfig();

export { config, type Config };
