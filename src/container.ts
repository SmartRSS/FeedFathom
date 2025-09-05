import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
} from "awilix";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import { RedisClient } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { buildAxios } from "$lib/cacheable-axios";
import { CommandBus } from "$lib/commands/command-bus";
import { MailSender } from "$lib/email/mail-sender";
import { FeedParser } from "$lib/feed-parser";
import { OpmlParser } from "$lib/opml-parser";
import { RedirectMap } from "$lib/redirect-map";
import { Cli } from "$lib/workers/cli";
import { Initializer } from "$lib/workers/initializer";
import { MailWorker } from "$lib/workers/mail";
import { MainWorker } from "$lib/workers/main";
import { type AppConfig, config } from "./config.ts";
import { ArticlesDataService } from "./db/data-services/article-data-service.ts";
import { FoldersDataService } from "./db/data-services/folder-data-service.ts";
import { SourcesDataService } from "./db/data-services/source-data-service.ts";
import { UsersDataService } from "./db/data-services/user-data-service.ts";
import { UserSourcesDataService } from "./db/data-services/user-source-data-service.ts";
import * as schema from "./db/schema.ts";
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
  articlesDataService: ArticlesDataService;
  axiosInstance: AxiosCacheInstance;
  cli: Cli;
  commandBus: CommandBus;
  appConfig: AppConfig;
  drizzleConnection: BunSQLDatabase<typeof schema>;
  feedParser: FeedParser;
  foldersDataService: FoldersDataService;
  initializer: Initializer;
  maintenanceState: MaintenanceState;
  mailSender: MailSender;
  mailWorker: MailWorker;
  mainWorker: MainWorker;
  opmlParser: OpmlParser;
  redis: RedisClient;
  redirectMap: RedirectMap;
  sourcesDataService: SourcesDataService;
  userSourcesDataService: UserSourcesDataService;
  usersDataService: UsersDataService;
  postgresQueue: PostgresQueue;
};

let redisClient: RedisClient;
// Use mock Redis during build process
if (process.env["BUILD"] === "true") {
  // MockRedisClient implements the RedisClient interface; assign as RedisClient to avoid unions
  redisClient = new MockRedisClient() as unknown as RedisClient;
} else {
  // Use real Redis in runtime
  redisClient = new RedisClient("redis://redis:6379", {
    connectionTimeout: 60 * 60 * 1000,
    idleTimeout: 0,
    autoReconnect: true,
    maxRetries: 100,
    enableOfflineQueue: true,
    tls: false,
    enableAutoPipelining: false,
  });
}

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
  articlesDataService: asClass(ArticlesDataService).singleton(),
  foldersDataService: asClass(FoldersDataService).singleton(),
  sourcesDataService: asClass(SourcesDataService).singleton(),
  userSourcesDataService: asClass(UserSourcesDataService).singleton(),
  usersDataService: asClass(UsersDataService).singleton(),

  // Services
  cli: asClass(Cli).singleton(),
  feedParser: asClass(FeedParser).singleton(),
  mailSender: asClass(MailSender).singleton(),
  mailWorker: asClass(MailWorker).singleton(),
  redirectMap: asClass(RedirectMap).singleton(),

  // Workers
  mainWorker: asClass(MainWorker).singleton(),
  initializer: asClass(Initializer).singleton(),
  postgresQueue: asClass(PostgresQueue).singleton(),
});

export default container;
