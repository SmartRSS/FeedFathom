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

export type Dependencies = {
  articlesRepository: ArticlesRepository;
  axiosInstance: AxiosCacheInstance;
  bullmqQueue: Queue;
  cli: Cli;
  commandBus: CommandBus;
  drizzleConnection: BunSQLDatabase<typeof schema>;
  feedParser: FeedParser;
  foldersRepository: FoldersRepository;
  initializer: Initializer;
  mailWorker: MailWorker;
  mainWorker: MainWorker;
  opmlParser: OpmlParser;
  redis: Redis;
  sourcesRepository: SourcesRepository;
  userSourcesRepository: UserSourcesRepository;
  usersRepository: UsersRepository;
};

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
  { schema },
);

// Create the container
const container = createContainer<Dependencies>({
  injectionMode: InjectionMode.CLASSIC,
  strict: true,
});

// Register basic dependencies first
container.register({
  axiosInstance: asFunction(buildAxios).singleton(),
  bullmqQueue: asValue(bullmq),
  commandBus: asClass(CommandBus).singleton(),
  drizzleConnection: asValue(databaseConnection),
  opmlParser: asFunction(() => {
    return new OpmlParser();
  }).singleton(),
  redis: asValue(ioRedisConnection),
});

// Register repositories
container.register({
  articlesRepository: asClass(ArticlesRepository).singleton(),
  foldersRepository: asClass(FoldersRepository).singleton(),
  sourcesRepository: asClass(SourcesRepository).singleton(),
  userSourcesRepository: asClass(UserSourcesRepository).singleton(),
  usersRepository: asClass(UsersRepository).singleton(),
});

// Register services that depend on repositories
container.register({
  cli: asClass(Cli).singleton(),
  feedParser: asClass(FeedParser).singleton(),
  mailWorker: asClass(MailWorker).singleton(),
});

// Register MainWorker separately to avoid circular dependencies
container.register({
  mainWorker: asClass(MainWorker)
    .inject(() => {
      return {
        bullmqQueue: container.cradle.bullmqQueue,
        commandBus: container.cradle.commandBus,
        feedParser: container.cradle.feedParser,
        redis: container.cradle.redis,
        sourcesRepository: container.cradle.sourcesRepository,
        userSourcesRepository: container.cradle.userSourcesRepository,
      };
    })
    .singleton(),
});

// Register Initializer last
container.register({
  initializer: asClass(Initializer)
    .inject(() => {
      return {
        cli: container.cradle.cli,
        commandBus: container.cradle.commandBus,
        drizzleConnection: container.cradle.drizzleConnection,
        feedParser: container.cradle.feedParser,
        mailWorker: container.cradle.mailWorker,
        mainWorker: container.cradle.mainWorker,
        sourcesRepository: container.cradle.sourcesRepository,
      };
    })
    .singleton(),
});

export default container;
