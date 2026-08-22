import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { AppConfig } from "../config.ts";
import journal from "../../drizzle/meta/_journal.json";
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

export function createPooledDrizzleConnection(
  databaseUrl: AppConfig["DATABASE_URL"],
  poolMax: number,
) {
  return createDrizzleConnection(
    databaseUrl,
    new SQL(databaseUrl, {
      idleTimeout: 60,
      max: poolMax,
      maxLifetime: 1_800,
    }),
  );
}

// A worker can outrace the migrator on a cold start, because Compose can
// only order starts, not completion -- and Swarm orders nothing at all (see
// compose.yml). Without this the first query hits a schema that is not there
// yet, the rejection is unhandled, and the process dies before it has even
// opened its healthcheck port, so an orchestrator sees a crash loop rather
// than a service waiting its turn.
//
// Drizzle has no runtime schema-verification API, but it does leave a
// runtime-queryable record: the migrator writes one drizzle.__drizzle_
// migrations row per applied migration, keyed by the same `when` timestamp
// that drizzle/meta/_journal.json carries, in the same transaction that
// applies it. So asking whether this build's newest known migration is
// present is an exact "is the schema at the version I was compiled for"
// check -- it stays false midway through an upgrade, which probing for a
// table's existence would not.
//
// A missing table (schema absent entirely) and a refused connection both
// surface as a rejected query, so one loop covers every not-ready state.
// Waiting forever is deliberate: a migration that has not run yet is not
// this process's problem to fail over. It logs occasionally rather than
// every second so a genuinely stuck instance is still readable.
// Bundled into each build, so this is the newest migration the running
// binary was compiled against -- not whatever happens to be on disk.
const latestMigration = Math.max(...journal.entries.map((entry) => entry.when));

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
        .catch(() => false);
    if (applied) return;
    if (attempt % 30 === 0)
      console.log(`Waiting for migration ${appliedAt} to be applied`);
    // eslint-disable-next-line no-await-in-loop -- Polling is sequential by nature.
    await Bun.sleep(intervalMs);
  }
}
