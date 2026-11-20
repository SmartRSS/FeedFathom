import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { AppConfig } from "#platform/config.ts";
import * as schema from "#platform/db/schema.ts";
import journal from "../../../drizzle/meta/_journal.json";

export function createDrizzleConnection(
  databaseUrl: AppConfig["DATABASE_URL"],
  {
    max,
    client = new SQL(databaseUrl, {
      idleTimeout: 60,
      ...(max === undefined ? {} : { max }),
      maxLifetime: 1_800,
    }),
  }: { client?: SQL; max?: number } = {},
) {
  return drizzle(client, { schema });
}

const latestMigration = Math.max(...journal.entries.map((entry) => entry.when));

const notReadyCodes = new Set([
  "42P01",
  "57P03",
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_REFUSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
]);

export function isNotReady(error: unknown) {
  return (
    error instanceof SQL.PostgresError &&
    (notReadyCodes.has(error.code) || notReadyCodes.has(error.errno ?? ""))
  );
}

export async function waitForMigration(
  client: SQL,
  appliedAt: number = latestMigration,
  intervalMs = 1_000,
) {
  for (let attempt = 0; ; attempt++) {
    const applied =
      // eslint-disable-next-line no-await-in-loop -- Polling is sequential by nature.
      await client`SELECT EXISTS (
          SELECT 1
          FROM "drizzle"."__drizzle_migrations"
          WHERE "created_at" = ${appliedAt}
        ) AS "applied"`
        .then(([row]: { applied: boolean }[]) => row?.applied ?? false)
        .catch((error: unknown) => {
          if (isNotReady(error)) return false;
          throw error;
        });
    if (applied) return;
    if (attempt % 30 === 0)
      console.log(`Waiting for migration ${appliedAt} to be applied`);
    // eslint-disable-next-line no-await-in-loop -- Polling is sequential by nature.
    await Bun.sleep(intervalMs);
  }
}
