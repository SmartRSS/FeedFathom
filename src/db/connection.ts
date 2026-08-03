import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { AppConfig } from "../config.ts";
import * as schema from "./schema.ts";

export function createDrizzleConnection(
  databaseUrl: AppConfig["DATABASE_URL"],
  client: SQL = new SQL(databaseUrl, {
    // ponytail: bounded pool lifetimes so a dead connection (e.g. postgres
    // restart) gets recycled instead of wedging the pool forever; raise if
    // connection churn shows up as a bottleneck.
    idleTimeout: 60,
    maxLifetime: 1_800,
  }),
) {
  return drizzle(client, { schema });
}
