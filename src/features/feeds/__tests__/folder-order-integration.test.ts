import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";
import { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { migrateDatabase } from "../../../migrator.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

// The dashboard renders this list in the order it arrives, and an OPML export
// should be byte-identical for an unchanged tree. Both need a stable order:
// renaming a folder is an UPDATE, and Postgres writes the new row version at the end of
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

test("a subscription goes only into the root or one of the user's own folders", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const foldersDataService = new FoldersDataService(drizzleConnection);
  const userSourcesDataService = new UserSourcesDataService(
    drizzleConnection,
    new SourcesDataService(drizzleConnection),
  );

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [owner, other] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('owner@example.test', 'owner', 'x'), ('other@example.test', 'other', 'x')
      RETURNING id`;
    const own = await foldersDataService.createFolder(owner!.id, "Own");
    const foreign = await foldersDataService.createFolder(other!.id, "Foreign");
    const subscribe = (parentId: null | number) =>
      userSourcesDataService.addSourceToUser(owner!.id, {
        homeUrl: "https://folders.test/",
        name: "Feed",
        parentId,
        url: "https://folders.test/feed",
      });

    expect(await subscribe(foreign.id)).toBeUndefined();
    const subscription = await subscribe(own.id);
    expect(subscription).toBeDefined();
    if (subscription === "refused") throw new Error("A feed has no owner");
    const move = (parentId: null | number) =>
      userSourcesDataService.updateUserSource(
        owner!.id,
        subscription!.source.id,
        { name: "Feed", parentId },
      );
    expect(await move(foreign.id)).toBeUndefined();
    expect(await move(null)).toBeDefined();
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});
