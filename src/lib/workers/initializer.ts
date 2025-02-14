import { type MailWorker } from "$lib/workers/mail";
import { type MainWorker } from "$lib/workers/main";
import { err as error_, llog } from "../../util/log";
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
    llog("init worker", process.env["INTEGRATION"]);
    const [_, ___, command, ...argument] = process.argv;
    if (command) {
      await this.cli.execute(command, argument);
      process.exit(0);
    }

    switch (process.env["INTEGRATION"]) {
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
        console.error("Wrong integration");
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
        error_(error.message);
      }

      process.exit(1);
    }
  }
}
