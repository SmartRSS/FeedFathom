import { afterAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { unreadCountsHeader } from "#shared/contracts/headers.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { UsersDataService } from "#features/auth/user-data-service.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import {
  createReaderRoutes,
  type ReaderRouteServices,
} from "#features/reader/routes.ts";
import { migrateDatabase } from "../../../migrator.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

const databaseUrl = requireDisposableDatabaseUrl();
const client = new SQL(databaseUrl);
const drizzleConnection = createDrizzleConnection(databaseUrl);
const usersDataService = new UsersDataService(drizzleConnection);
const userSourcesDataService = new UserSourcesDataService(
  drizzleConnection,
  new SourcesDataService(drizzleConnection),
);
const reader = createReaderRoutes(
  strictFake<ReaderRouteServices>(
    {
      articlesDataService: new ArticlesDataService(drizzleConnection),
      foldersDataService: strictFake({}, "foldersDataService"),
      userSourcesDataService,
      usersDataService,
    },
    "readerServices",
  ),
);

let cookie = "";
let ids = new Map<string, number>();
let sources = { other: 0, stranger: 0, subscribed: 0 };

afterAll(async () => {
  await drizzleConnection.$client.close();
  await client.close();
});

async function addSource(url: string) {
  const [source] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url, kind, last_success, not_before)
    VALUES (${url}, ${url}, 'feed', NOW(), NOW()) RETURNING id`;
  return source!.id;
}

async function addArticle(sourceId: number, title: string) {
  const [article] = await client<{ id: string }[]>`
    INSERT INTO articles (source_id, guid, author, title, url, content, published_at, updated_at, last_seen_in_feed_at)
    VALUES (${sourceId}, ${title}, 'a', ${title}, '', ${`<p>${title}</p>`}, NOW(), NOW(), NOW())
    RETURNING id`;
  ids.set(title, Number(article!.id));
}

beforeEach(async () => {
  await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
  await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
  await client`CREATE SCHEMA "public"`;
  await migrateDatabase(databaseUrl, migrationsFolder);

  const [user] = await client<{ id: number }[]>`
    INSERT INTO users (email, name, password, status)
    VALUES ('reader@example.test', 'reader', 'x', 'active') RETURNING id`;
  sources = {
    other: await addSource("https://other.test/feed"),
    stranger: await addSource("https://stranger.test/feed"),
    subscribed: await addSource("https://subscribed.test/feed"),
  };
  for (const sourceId of [sources.subscribed, sources.other]) {
    // eslint-disable-next-line no-await-in-loop -- Fixture rows.
    await client`
      INSERT INTO user_sources (user_id, source_id, name, created_at)
      VALUES (${user!.id}, ${sourceId}, 'sub', NOW() - INTERVAL '60 days')`;
  }
  ids = new Map();
  await addArticle(sources.subscribed, "Kubernetes networking");
  await addArticle(sources.subscribed, "Sourdough starter");
  await addArticle(sources.subscribed, "Garden notes");
  await addArticle(sources.other, "Kubernetes operators");
  await addArticle(sources.stranger, "Kubernetes secrets");
  await userSourcesDataService.recomputeUnreadCounts(
    [sources.subscribed, sources.other],
    user!.id,
  );
  cookie = `sid=${await usersDataService.createSession(user!.id, "x", "Browser")}`;
});

const idOf = (title: string) => ids.get(title) ?? 0;

function call(method: string, body: unknown, authed = true) {
  return reader.handle(
    new Request("http://localhost/api/articles", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(authed ? { cookie } : {}),
      },
      method,
    }),
  );
}

async function titles(body: unknown) {
  const response = await call("POST", body);
  expect(response.status).toBe(200);
  const listed: { title: string }[] = await response.json();
  return listed.map(({ title }) => title).toSorted();
}

test("marking articles read moves them between the filters and recounts the badge", async () => {
  const read = await call("PATCH", {
    articleIdList: [idOf("Kubernetes networking"), idOf("Sourdough starter")],
    read: true,
  });

  expect(read.status).toBe(200);
  expect(await read.json()).toEqual([
    idOf("Kubernetes networking"),
    idOf("Sourdough starter"),
  ]);
  expect(read.headers.get(unreadCountsHeader)).toBe(
    JSON.stringify({ [sources.subscribed]: 1 }),
  );
  const subscribed = [sources.subscribed];
  expect(await titles({ sources: subscribed })).toEqual(["Garden notes"]);
  expect(await titles({ filter: "unread", sources: subscribed })).toEqual([
    "Garden notes",
  ]);
  expect(await titles({ filter: "read", sources: subscribed })).toEqual([
    "Kubernetes networking",
    "Sourdough starter",
  ]);
  expect(await titles({ filter: "all", sources: subscribed })).toEqual([
    "Garden notes",
    "Kubernetes networking",
    "Sourdough starter",
  ]);
  expect(
    (await call("POST", { filter: "everything", sources: subscribed })).status,
  ).toBe(422);

  const unread = await call("PATCH", {
    articleIdList: [idOf("Sourdough starter")],
    read: false,
  });

  expect(unread.status).toBe(200);
  expect(unread.headers.get(unreadCountsHeader)).toBe(
    JSON.stringify({ [sources.subscribed]: 2 }),
  );
  expect(await titles({ filter: "read", sources: subscribed })).toEqual([
    "Kubernetes networking",
  ]);
  expect((await call("PATCH", { articleIdList: [], read: true })).status).toBe(
    422,
  );
  expect(
    (
      await call(
        "PATCH",
        { articleIdList: [idOf("Garden notes")], read: true },
        false,
      )
    ).status,
  ).toBe(401);
  expect(await titles({ filter: "read", sources: subscribed })).toEqual([
    "Kubernetes networking",
  ]);
});

test("a search covers every subscription, whatever sources are selected", async () => {
  const everywhere = ["Kubernetes networking", "Kubernetes operators"];

  expect(await titles({ query: "  kubernetes ", sources: [] })).toEqual(
    everywhere,
  );
  expect(
    await titles({ query: "kubernetes", sources: [sources.subscribed] }),
  ).toEqual(everywhere);
  expect(
    await titles({ query: "sourdough", sources: [sources.other] }),
  ).toEqual(["Sourdough starter"]);
  expect((await call("POST", { query: "   ", sources: [] })).status).toBe(422);
  expect(
    (await call("POST", { query: "x".repeat(201), sources: [] })).status,
  ).toBe(422);
  expect(await titles({ sources: [] })).toEqual([]);
});
