import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";
import { OpmlImportService } from "#features/feeds/opml-import-service.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
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
  const importer = new OpmlImportService(
    connection,
    {
      async enqueueSource(source) {
        queued.push(source.id);
      },
    },
    new SourcesDataService(connection),
  );
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

const feed = (name: string) => ({
  homeUrl: "",
  name,
  type: "source" as const,
  xmlUrl: `https://${name}.test/feed`,
});

// Folders are one level deep (user_folders has no parent) and a user's folder
// is found by name, so a nested OPML folder lands in the top-level folder of
// the same name rather than a second one beside it. A feed already subscribed
// keeps its folder and name: the import only adds what is missing.
test("importing a different tree merges same-named folders and leaves existing subscriptions alone", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const connection = createDrizzleConnection(databaseUrl);
  const queued: string[] = [];
  const importer = new OpmlImportService(
    connection,
    {
      async enqueueSource(source) {
        queued.push(source.url);
      },
    },
    new SourcesDataService(connection),
  );
  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);
    const [user] = await client<
      { id: number }[]
    >`INSERT INTO users (email, name, password) VALUES ('import@example.test', 'import', 'x') RETURNING id`;
    const userId = user!.id;
    // Built by hand, named unlike the OPML: "news" filed under News, "misc"
    // under Misc, "loose" in no folder.
    const [news, misc] = await client<{ id: number }[]>`
      INSERT INTO user_folders (user_id, name) VALUES
        (${userId}, 'News'), (${userId}, 'Misc')
      RETURNING id`;
    for (const [name, folderId] of [
      ["news", news!.id],
      ["misc", misc!.id],
      ["loose", null],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- three fixture rows.
      await client`
        WITH source AS (
          INSERT INTO sources (url, home_url)
          VALUES (${feed(name).xmlUrl}, ${`https://${name}.test`})
          RETURNING id
        )
        INSERT INTO user_sources (user_id, source_id, name, parent_id)
        SELECT ${userId}, id, ${`My ${name}`}, ${folderId} FROM source`;
    }
    const existing = await client<
      { source_id: number }[]
    >`SELECT * FROM user_sources ORDER BY source_id`;

    await importer.insertTree(
      userId,
      [
        {
          children: [
            {
              children: [feed("news"), feed("fresh")],
              name: "News",
              type: "folder",
            },
            feed("misc"),
            feed("loose"),
            feed("tech"),
          ],
          name: "Tech",
          type: "folder",
        },
      ],
      "b".repeat(64),
    );

    expect(
      (
        await client<
          { name: string }[]
        >`SELECT name FROM user_folders ORDER BY name`
      ).map((row) => row.name),
    ).toEqual(["Misc", "News", "Tech"]);
    expect(
      await client`SELECT * FROM user_sources WHERE source_id IN ${client(existing.map((row) => row.source_id))} ORDER BY source_id`,
    ).toEqual(existing);
    expect([
      ...(await client<{ folder: string; name: string }[]>`
        SELECT s.name, f.name AS folder FROM user_sources s
        JOIN user_folders f ON f.id = s.parent_id
        WHERE s.name IN ('fresh', 'tech') ORDER BY s.name`),
    ]).toEqual([
      { folder: "News", name: "fresh" },
      { folder: "Tech", name: "tech" },
    ]);
    const [fresh] = await client<
      { parent_id: number }[]
    >`SELECT parent_id FROM user_sources WHERE name = 'fresh'`;
    expect(fresh!.parent_id).toBe(news!.id);
    expect(await client`SELECT * FROM user_sources`).toHaveLength(5);
    expect(await client`SELECT * FROM sources`).toHaveLength(5);
    expect(queued.toSorted()).toEqual([
      "https://fresh.test/feed",
      "https://tech.test/feed",
    ]);
  } finally {
    await connection.$client.close();
    await client.close();
  }
});
