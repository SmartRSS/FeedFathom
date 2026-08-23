import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { jobFailures } from "#platform/db/schemas/job-failures.ts";

export class JobFailuresDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  public async record(jobType: string, errorMessage: string) {
    await this.drizzleConnection.insert(jobFailures).values({
      errorMessage,
      jobType,
    });
  }
}
