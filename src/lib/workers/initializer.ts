import type { CommandBus } from "$lib/commands/command-bus";
import {
  type CommandRegistryDependencies,
  registerCommandHandlers,
} from "$lib/commands/registry";
import type { FeedParser } from "$lib/feed-parser";
import type { MailWorker } from "$lib/workers/mail";
import type { MainWorker } from "$lib/workers/main";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { AppConfig } from "../../config.ts";
import type { SourcesDataService } from "../../db/data-services/source-data-service.ts";
import { llog, logError } from "../../util/log.ts";
import type { Cli } from "./cli.ts";

// Schedule the next task function definition with a config object
export class Initializer {
  constructor(
    private readonly cli: Cli,
    private readonly commandBus: CommandBus,
    private readonly drizzleConnection: BunSQLDatabase,
    private readonly feedParser: FeedParser,
    private readonly mailWorker: MailWorker,
    private readonly mainWorker: MainWorker,
    private readonly sourcesDataService: SourcesDataService,
    private readonly appConfig: AppConfig,
  ) {}

  public async initialize() {
    const [_, ___, command, ...argument] = process.argv;
    if (command) {
      await this.cli.execute(command, argument);
      process.exit(0);
    }

    // Register command handlers
    this.registerCommandHandlers();

    // Set up cleanup on process exit
    this.setupCleanupHandlers();

    // Check if INTEGRATION is defined
    const integration = this.appConfig["INTEGRATION"];
    if (!integration) {
      logError("INTEGRATION environment variable is not set");
      throw new Error("INTEGRATION environment variable is not set");
    }

    switch (integration) {
      case "mail": {
        this.mailWorker.initialize();
        break;
      }

      case "migrator": {
        await this.runMigrator();
        break;
      }

      case "worker": {
        await this.mainWorker.initialize();
        break;
      }

      default: {
        logError(`Unknown integration: ${integration}`);
        throw new Error(`Unknown integration: ${integration}`);
      }
    }
  }

  private registerCommandHandlers() {
    try {
      // Create dependencies object with proper interface
      const commandDependencies: CommandRegistryDependencies = {
        commandBus: this.commandBus,
        feedParser: this.feedParser,
        sourcesDataService: this.sourcesDataService,
      };

      // Register command handlers
      registerCommandHandlers(commandDependencies);
    } catch (error) {
      logError("Failed to register command handlers:", error);
      throw error;
    }
  }

  private async runMigrator() {
    await migrate(this.drizzleConnection, { migrationsFolder: "./drizzle" });
    llog("Migrations complete");
    process.exit(0);
  }

  private setupCleanupHandlers() {
    // Clean up on process exit
    process.on("SIGTERM", () => {
      // Nothing to clean up anymore
    });

    process.on("SIGINT", () => {
      // Nothing to clean up anymore
    });
  }
}
