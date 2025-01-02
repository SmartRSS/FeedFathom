import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { MainWorker } from "$lib/workers/main";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { MailWorker } from "$lib/workers/mail";
import { err, llog } from "../../util/log";

// Schedule the next task function definition with a config object
export class Initializer {
  constructor(
    private readonly mainWorker: MainWorker,
    private readonly drizzleConnection: PostgresJsDatabase,
    private readonly mailWorker: MailWorker,
  ) {}

  public async initialize() {
    llog("init worker", process.env["INTEGRATION"]);
    switch (process.env["INTEGRATION"]) {
      case "migrator": {
        await this.runMigrator();
        break;
      }
      case "mail": {
        this.mailWorker.initialize();
        break;
      }
      case "singleton": {
        // Singleton logic
        break;
      }
      case "worker": {
        await this.mainWorker.initialize();
        break;
      }
      default: {
        err(`unknown integration: ${process.env["INTEGRATION"]}`);
        process.exit(1);
      }
    }
  }

  private async runMigrator() {
    try {
      await migrate(this.drizzleConnection, {
        migrationsFolder: "./drizzle",
      });
      process.exit(0);
    } catch (error: unknown) {
      if (error instanceof Error) {
        err(error.message);
      }
      process.exit(1);
    }
  }
}
