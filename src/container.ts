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
import { MailSender } from "$lib/email/mail-sender";
import {
  InjectionMode,
  asClass,
  asFunction,
  asValue,
  createContainer,
} from "awilix";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import { RedisClient } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { type AppConfig, config } from "./config.ts";
import { MockRedisClient } from "./lib/mock-redis-client.ts";
import { PostgresQueue } from "./lib/postgres-queue.ts";

export class MaintenanceState {
  private _isMaintenanceMode = false;

  get isMaintenanceMode(): boolean {
    return this._isMaintenanceMode;
  }

  set isMaintenanceMode(value: boolean) {
    this._isMaintenanceMode = value;
  }
}

export type Dependencies = {
  articlesRepository: ArticlesRepository;
  axiosInstance: AxiosCacheInstance;
  cli: Cli;
  commandBus: CommandBus;
  appConfig: AppConfig;
  drizzleConnection: BunSQLDatabase<typeof schema>;
  feedParser: FeedParser;
  foldersRepository: FoldersRepository;
  initializer: Initializer;
  maintenanceState: MaintenanceState;
  mailSender: MailSender;
  mailWorker: MailWorker;
  mainWorker: MainWorker;
  opmlParser: OpmlParser;
  redis: RedisClient;
  sourcesRepository: SourcesRepository;
  userSourcesRepository: UserSourcesRepository;
  usersRepository: UsersRepository;
  postgresQueue: PostgresQueue;
};

const redisClient = (() => {
  // Use mock Redis during build process
  if (process.env["BUILD"] === "true") {
    return new MockRedisClient();
  }

  // Use real Redis in runtime
  return new RedisClient("redis://redis:6379", {
    connectionTimeout: 60 * 60 * 1000,
    idleTimeout: 0,
    autoReconnect: true,
    maxRetries: 100,
    enableOfflineQueue: true,
    tls: false,
    enableAutoPipelining: false,
  });
})();

await redisClient.connect();

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

// Register all dependencies in a single call
container.register({
  // Basic dependencies
  appConfig: asValue(config),
  redis: asValue(redisClient),
  drizzleConnection: asValue(databaseConnection),
  axiosInstance: asFunction(buildAxios).singleton(),
  commandBus: asClass(CommandBus).singleton(),
  opmlParser: asFunction(() => new OpmlParser()).singleton(),
  maintenanceState: asClass(MaintenanceState).singleton(),

  // Repositories
  articlesRepository: asClass(ArticlesRepository).singleton(),
  foldersRepository: asClass(FoldersRepository).singleton(),
  sourcesRepository: asClass(SourcesRepository).singleton(),
  userSourcesRepository: asClass(UserSourcesRepository).singleton(),
  usersRepository: asClass(UsersRepository).singleton(),

  // Services
  cli: asClass(Cli).singleton(),
  feedParser: asClass(FeedParser).singleton(),
  mailSender: asClass(MailSender).singleton(),
  mailWorker: asClass(MailWorker).singleton(),

  // Workers
  mainWorker: asClass(MainWorker).singleton(),
  initializer: asClass(Initializer).singleton(),
  postgresQueue: asClass(PostgresQueue).singleton(),
});

// biome-ignore lint/style/noDefaultExport: TODO
export default container;
