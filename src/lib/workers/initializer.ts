import { type MailWorker } from "$lib/workers/mail";
import { type MainWorker } from "$lib/workers/main";
import { logError } from "../../util/log";
import { type Cli } from "./cli";
import { type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Schedule the next task function definition with a config object
export class Initializer {
  constructor(
    private readonly mainWorker: MainWorker,
    private readonly drizzleConnection: BunSQLDatabase,
    private readonly mailWorker: MailWorker,
    private readonly cli: Cli,
  ) {}

  public async initialize() {
    const [_, ___, command, ...argument] = process.argv;
    if (command) {
      await this.cli.execute(command, argument);
      // eslint-disable-next-line n/no-process-exit
      process.exit(0);
    }

    // Check if INTEGRATION is defined
    // eslint-disable-next-line n/no-process-env
    const integration = process.env["INTEGRATION"];
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
        logError("Wrong integration");
        throw new Error("Wrong integration");
      }
    }
  }

  private async runMigrator() {
    try {
      await migrate(this.drizzleConnection, {
        migrationsFolder: "./drizzle",
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        logError(error.message);
      }

      throw new Error("1");
    }
  }
}
