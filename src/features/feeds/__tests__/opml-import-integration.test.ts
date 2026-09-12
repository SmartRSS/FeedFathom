import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { requireDisposableDatabaseUrl } from "#features/feeds/__tests__/disposable-database-url.ts";
import { OpmlImportService } from "#features/feeds/opml-import-service.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { migrateDatabase } from "../../../migrator.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

test("repeat OPML imports restore missing subscriptions and preserve existing state", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const connection = createDrizzleConnection(databaseUrl);
  const queued: number[] = [];
  const importer = new OpmlImportService(connection, {
    async enqueueSource(source) {
      queued.push(source.id);
    },
  });
  const tree = [
    {
      children: [
        {
          homeUrl: "",
          name: "Keep",
          type: "source" as const,
          xmlUrl: "https://keep.test/feed",
        },
        {
          homeUrl: "",
          name: "Restore",
          type: "source" as const,
          xmlUrl: "https://restore.test/feed",
        },
      ],
      name: "Backup",
      type: "folder" as const,
    },
  ];
  const hash = "a".repeat(64);
  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);
    const [user] = await client<
      { id: number }[]
    >`INSERT INTO users (email, name, password) VALUES ('import@example.test', 'import', 'x') RETURNING id`;
    const userId = user!.id;
    await importer.insertTree(userId, tree, hash);
    const [kept] = await client<
      { source_id: number }[]
    >`SELECT source_id FROM user_sources WHERE name = 'Keep'`;
    const [folder] = await client<
      { id: number }[]
    >`INSERT INTO user_folders (user_id, name) VALUES (${userId}, 'Moved') RETURNING id`;
    await client`UPDATE user_sources SET parent_id = ${folder!.id}, name = 'Renamed' WHERE source_id = ${kept!.source_id}`;
    await client`INSERT INTO user_articles (user_id, source_id, guid, read_at) VALUES (${userId}, ${kept!.source_id}, 'read-entry', '2026-01-01')`;
    const before =
      await client`SELECT * FROM user_sources WHERE source_id = ${kept!.source_id}`;
    const readState = await client`SELECT * FROM user_articles`;
    await client`DELETE FROM user_sources WHERE name = 'Restore'`;
    queued.length = 0;
    await Promise.all([
      importer.insertTree(userId, tree, hash),
      importer.insertTree(userId, tree, hash),
    ]);
    expect(await client`SELECT * FROM user_sources`).toHaveLength(2);
    expect(
      await client`SELECT * FROM user_sources WHERE source_id = ${kept!.source_id}`,
    ).toEqual(before);
    expect(await client`SELECT * FROM user_articles`).toEqual(readState);
    expect(await client`SELECT * FROM user_folders`).toHaveLength(2);
    expect(queued).toHaveLength(1);
    const [restored] =
      await client`SELECT f.name FROM user_sources s JOIN user_folders f ON f.id = s.parent_id WHERE s.name = 'Restore'`;
    expect(restored!.name).toBe("Backup");
    await importer.insertTree(userId, tree, "b".repeat(64));
    expect(await client`SELECT * FROM user_sources`).toHaveLength(2);
    expect(await client`SELECT * FROM user_folders`).toHaveLength(2);
    expect(queued).toHaveLength(1);
    await client`DELETE FROM user_folders WHERE name = 'Backup'`;
    await importer.insertTree(userId, tree, hash);
    expect(await client`SELECT * FROM user_sources`).toHaveLength(2);
    expect(await client`SELECT * FROM user_folders`).toHaveLength(2);
    expect(await client`SELECT * FROM user_articles`).toEqual(readState);
    expect(queued).toHaveLength(2);
  } finally {
    await connection.$client.close();
    await client.close();
  }
});
