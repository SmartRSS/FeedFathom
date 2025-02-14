import { buildAxios } from "$lib/cacheable-axios";
import { ArticlesRepository } from "$lib/db/article-repository";
import { FoldersRepository } from "$lib/db/folder-repository";
import { SourcesRepository } from "$lib/db/source-repository";
import { UsersRepository } from "$lib/db/user-repository";
import { UserSourcesRepository } from "$lib/db/user-source-repository";
import { FeedParser } from "$lib/feed-parser";
import { OpmlParser } from "$lib/opml-parser";
import type * as schema from "$lib/schema";
import { Cli } from "$lib/workers/cli";
import { Initializer } from "$lib/workers/initializer";
import { MailWorker } from "$lib/workers/mail";
import { MainWorker } from "$lib/workers/main";
import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
} from "awilix";
import { type AxiosCacheInstance } from "axios-cache-interceptor";
import { Queue } from "bullmq";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import Redis from "ioredis";

export type Dependencies = {
  articlesRepository: ArticlesRepository;
  axiosInstance: AxiosCacheInstance;
  bullmqQueue: Queue;
  cli: Cli;
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
}

const ioRedisConnection = new Redis({
  db: 0,
  host: "redis",
  lazyConnect: false,
  maxRetriesPerRequest: null,
  port: 6_379,
});

const bullmq = new Queue("tasks", {
  connection: ioRedisConnection,
});
const container = createContainer<Dependencies>({
  injectionMode: InjectionMode.CLASSIC,
  strict: true,
});
container.register({
  articlesRepository: asClass(ArticlesRepository).singleton(),
  axiosInstance: asFunction(buildAxios).singleton(),
  bullmqQueue: asValue(bullmq),
  cli: asClass(Cli).singleton(),
  drizzleConnection: asValue(
    drizzle("postgresql://postgres:postgres@postgres:5432/postgres"),
  ),
  feedParser: asClass(FeedParser).singleton(),
  foldersRepository: asClass(FoldersRepository).singleton(),
  initializer: asClass(Initializer).singleton(),
  mailWorker: asClass(MailWorker).singleton(),
  mainWorker: asClass(MainWorker).singleton(),
  opmlParser: asFunction(() => {return new OpmlParser()}).singleton(),
  redis: asValue(ioRedisConnection),
  sourcesRepository: asClass(SourcesRepository).singleton(),
  userSourcesRepository: asClass(UserSourcesRepository).singleton(),
  usersRepository: asClass(UsersRepository).singleton(),
});

export default container;
