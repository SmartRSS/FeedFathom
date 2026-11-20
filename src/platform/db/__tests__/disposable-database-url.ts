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
