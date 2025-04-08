import { buildAxios } from "$lib/cacheable-axios";
import { CommandBus } from "$lib/commands/command-bus";
import { ArticlesRepository } from "$lib/db/article-repository";
import { FoldersRepository } from "$lib/db/folder-repository";
import { SourcesRepository } from "$lib/db/source-repository";
import { UsersRepository } from "$lib/db/user-repository";
import { UserSourcesRepository } from "$lib/db/user-source-repository";
import { FeedParser } from "$lib/feed-parser";
import { OpmlParser } from "$lib/opml-parser";
// biome-ignore lint/style/noNamespaceImport: <explanation>
import * as schema from "$lib/schema.ts";
import { Cli } from "$lib/workers/cli";
import { Initializer } from "$lib/workers/initializer";
import { MailWorker } from "$lib/workers/mail";
import { MainWorker } from "$lib/workers/main";
import {
  InjectionMode,
  asClass,
  asFunction,
  asValue,
  createContainer,
} from "awilix";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import { Queue } from "bullmq";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import Redis from "ioredis";
import { type AppConfig, config } from "./config.ts";

export type Dependencies = {
  articlesRepository: ArticlesRepository;
  axiosInstance: AxiosCacheInstance;
  bullmqQueue: Queue | null;
  cli: Cli;
  commandBus: CommandBus;
  appConfig: AppConfig;
  drizzleConnection: BunSQLDatabase<typeof schema> | null;
  feedParser: FeedParser;
  foldersRepository: FoldersRepository;
  initializer: Initializer;
  mailWorker: MailWorker;
  mainWorker: MainWorker;
  opmlParser: OpmlParser;
  redis: Redis | null;
  sourcesRepository: SourcesRepository;
  userSourcesRepository: UserSourcesRepository;
  usersRepository: UsersRepository;
};

// Create the container
const container = createContainer<Dependencies>({
  injectionMode: InjectionMode.CLASSIC,
  strict: true,
});

// Create Redis connection
const ioRedisConnection = new Redis({
  db: 0,
  host: "redis",
  lazyConnect: false,
  maxRetriesPerRequest: null,
  port: 6_379,
});

// Create BullMQ queue
const bullmq = new Queue("tasks", {
  connection: ioRedisConnection,
});

// Create database connection
const databaseConnection = drizzle(
  "postgresql://postgres:postgres@postgres:5432/postgres",
  {
    schema,
  },
);

// Register all dependencies
container.register({
  // Basic dependencies
  redis: asValue(ioRedisConnection),
  bullmqQueue: asValue(bullmq),
  drizzleConnection: asValue(databaseConnection),
  axiosInstance: asFunction(buildAxios).singleton(),
  // Application dependencies
  appConfig: asValue(config),
  commandBus: asClass(CommandBus).singleton(),
  opmlParser: asFunction(() => new OpmlParser()).singleton(),
  articlesRepository: asClass(ArticlesRepository).singleton(),
  foldersRepository: asClass(FoldersRepository).singleton(),
  sourcesRepository: asClass(SourcesRepository).singleton(),
  userSourcesRepository: asClass(UserSourcesRepository).singleton(),
  usersRepository: asClass(UsersRepository).singleton(),
  cli: asClass(Cli).singleton(),
  feedParser: asClass(FeedParser).singleton(),
  mailWorker: asClass(MailWorker).singleton(),
  mainWorker: asClass(MainWorker).singleton(),
  initializer: asClass(Initializer).singleton(),
});

export { container };
