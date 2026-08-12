import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "../schema.ts";
import { jobFailures } from "../schemas/jobFailures";

export class JobFailuresDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  public async record(jobType: string, errorMessage: string) {
    await this.drizzleConnection.insert(jobFailures).values({
      jobType,
      errorMessage,
    });
  }
}
