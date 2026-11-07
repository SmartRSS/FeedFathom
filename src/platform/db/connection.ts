import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { AppConfig } from "#platform/config.ts";
import * as schema from "#platform/db/schema.ts";
import journal from "../../../drizzle/meta/_journal.json";

export function createDrizzleConnection(
  databaseUrl: AppConfig["DATABASE_URL"],
  {
    max,
    // ponytail: bounded pool lifetimes so a dead connection (e.g. postgres
    // restart) gets recycled instead of wedging the pool forever; raise if
    // connection churn shows up as a bottleneck.
    client = new SQL(databaseUrl, {
      idleTimeout: 60,
      ...(max === undefined ? {} : { max }),
      maxLifetime: 1_800,
    }),
  }: { client?: SQL; max?: number } = {},
) {
  return drizzle(client, { schema });
}

// A worker can outrace the migrator on a cold start: Compose orders starts,
// not completion, and Swarm orders nothing (see compose.yml). Without this the
// first query hits a missing schema and the process dies before opening its
// healthcheck port, so the orchestrator sees a crash loop.
//
// The migrator writes one drizzle.__drizzle_migrations row per migration, in
// the same transaction that applies it, keyed by the `when` timestamp from
// drizzle/meta/_journal.json. Checking for this build's newest migration is
// therefore an exact "is the schema at the version I was compiled for" test,
// and stays false midway through an upgrade -- probing for a table would not.
//
// Waiting forever is deliberate; the log is throttled so a genuinely stuck
// instance stays readable.
// Bundled into each build, so this is the newest migration the running
// binary was compiled against -- not whatever happens to be on disk.
const latestMigration = Math.max(...journal.entries.map((entry) => entry.when));

// The schema not there yet, or a database not accepting connections yet. Bun
// reports an unresolvable host as a refused connection too, which on Swarm
// can also be a service not scheduled yet. Anything else -- a wrong password,
// a database that does not exist -- is configuration, and waiting would only
// hide it.
const notReadyCodes = new Set([
  "42P01", // undefined_table
  "57P03", // cannot_connect_now: the server is starting up
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
