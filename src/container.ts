import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
} from "awilix";
import { SourcesRepository } from "$lib/db/source-repository";
import { UserRepository } from "$lib/db/user-repository";
import { OpmlParser } from "$lib/opml-parser";
import { FeedParser } from "$lib/feed-parser";
import { Queue } from "bullmq";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import * as schema from "$lib/schema";
import { UserSourceRepository } from "$lib/db/user-source-repository";
import { ArticleRepository } from "$lib/db/article-repository";
import { FolderRepository } from "$lib/db/folder-repository";
import { MainWorker } from "$lib/workers/main";
import { MailWorker } from "$lib/workers/mail";
import { Initializer } from "$lib/workers/initializer";
import { buildAxios } from "$lib/cacheable-axios";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import Redis from "ioredis";

export interface Dependencies {
  axiosInstance: AxiosCacheInstance;
  sourcesRepository: SourcesRepository;
  userSourcesRepository: UserSourceRepository;
  articlesRepository: ArticleRepository;
  foldersRepository: FolderRepository;
  usersRepository: UserRepository;
  opmlParser: OpmlParser;
  feedParser: FeedParser;
  bullmqQueue: Queue;
  drizzleConnection: BunSQLDatabase<typeof schema>;
  mainWorker: MainWorker;
  mailWorker: MailWorker;
  initializer: Initializer;
  redis: Redis;
}

const ioRedisConnection = new Redis({
  host: "redis",
  port: 6379,
  lazyConnect: false,
  db: 0,
  maxRetriesPerRequest: null,
});

const bullmq = new Queue("tasks", {
  connection: ioRedisConnection,
});
const container = createContainer<Dependencies>({
  injectionMode: InjectionMode.CLASSIC,
  strict: true,
});
container.register({
  axiosInstance: asFunction(buildAxios).singleton(),
  sourcesRepository: asClass(SourcesRepository).singleton(),
  userSourcesRepository: asClass(UserSourceRepository).singleton(),
  articlesRepository: asClass(ArticleRepository).singleton(),
  foldersRepository: asClass(FolderRepository).singleton(),
  usersRepository: asClass(UserRepository).singleton(),
  opmlParser: asFunction(() => new OpmlParser()).singleton(),
  feedParser: asClass(FeedParser).singleton(),
  bullmqQueue: asValue(bullmq),
  drizzleConnection: asValue(
    drizzle("postgresql://postgres:postgres@postgres:5432/postgres"),
  ),
  mainWorker: asClass(MainWorker).singleton(),
  mailWorker: asClass(MailWorker).singleton(),
  initializer: asClass(Initializer).singleton(),
  redis: asValue(ioRedisConnection),
});

export default container;
