import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { requireDisposableDatabaseUrl } from "#features/feeds/__tests__/disposable-database-url.ts";
import { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { migrateDatabase } from "../../../migrator.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

// The dashboard renders this list in the order it arrives, and an OPML export
// is only a no-op on re-import if two exports of an unchanged tree are
// byte-identical. Both need an order the database actually promises: renaming
// a folder is an UPDATE, and Postgres writes the new row version at the end of
// the heap, so an unordered select returned the renamed folder last.
test("folders come back by name, including after a rename", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const foldersDataService = new FoldersDataService(drizzleConnection);

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [user] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('folders@example.test', 'folders', 'x') RETURNING id`;
    const names = async () =>
      (await foldersDataService.getUserFolders(user!.id)).map(
        (folder) => folder.name,
      );

    const alpha = await foldersDataService.createFolder(user!.id, "Alpha");
    await foldersDataService.createFolder(user!.id, "Beta");
    await foldersDataService.createFolder(user!.id, "Gamma");
    expect(await names()).toEqual(["Alpha", "Beta", "Gamma"]);

    await foldersDataService.renameFolder(user!.id, alpha.id, "Delta");
    expect(await names()).toEqual(["Beta", "Delta", "Gamma"]);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});
