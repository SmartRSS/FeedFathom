/**
 * The database an integration test is allowed to drop schemas in.
 *
 * Every one of these tests begins by dropping `public` and re-migrating, so
 * the guard is the only thing between a mistyped variable and someone's real
 * database. It lives here rather than being repeated per test file for the
 * same reason any check does: four copies drift, and one of them read a
 * different environment variable entirely, so `test:migrations` needed two
 * names set to the same value to run at all.
 */
export function requireDisposableDatabaseUrl(): string {
  const databaseUrl = process.env["MIGRATION_TEST_DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("MIGRATION_TEST_DATABASE_URL is required");
  }
  const parsed = new URL(databaseUrl);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !/(?:^|[_-])(?:disposable|migration_test|test)(?:[_-]|$)/i.test(name)
  ) {
    throw new Error(
      "MIGRATION_TEST_DATABASE_URL must be a postgres: URL with a host, targeting a database whose name carries a test or disposable marker",
    );
  }
  return databaseUrl;
}
