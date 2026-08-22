---
layout: default
title: Contributing
nav_order: 4
---

# Contributing to FeedFathom

## Getting Started

1. Fork the repository
2. Create a feature branch:
```bash
git checkout -b feature-branch-name
```

3. Make your changes
4. Commit your changes:
```bash
git commit -m 'Add feature'
```

5. Push to your fork:
```bash
git push origin feature-branch-name
```

6. Create a Pull Request

## Guidelines

- Follow existing code style
- Add tests for new features
- Update documentation as needed
- Keep commits focused and meaningful
- Run the complete gate before opening a pull request:

```bash
bun run quality
```

Use `bun run test:unit`, `bun run test:browser`, or `bun run lint` while iterating. Browser tests require the Chromium binary installed by `bunx playwright install chromium`.

## Database Migrations

Generate a migration with `bun run generate-migrations`, which writes a numbered `.sql` file into `drizzle/` and records it in `drizzle/meta/_journal.json`. The history starts from a squashed baseline rather than the project's first commit; see the deployment notes for what adopting that baseline required. Migrations are forward-only and must follow expand/contract compatibility, because a rolled-back deployment does not run a down migration.

One convention is load-bearing. Drizzle runs each migration inside a transaction, so a generated `CREATE INDEX` takes an `ACCESS EXCLUSIVE` lock on the table for the whole build — instant on an empty table, an outage on a populated one. To avoid that, edit the generated statement to read `CREATE INDEX IF NOT EXISTS`:

```sql
CREATE INDEX IF NOT EXISTS "articles_updated_at_idx" ON "articles" USING btree ("updated_at");
```

`IF NOT EXISTS` is the opt-in marker, not decoration. Before running migrations, `src/migrator.ts` reads every unapplied migration file, extracts exactly those statements, and builds each index `CONCURRENTLY` outside any transaction. The in-transaction statement then finds the index already present and does nothing. Nothing has to be registered anywhere else — the migration file is the only place an index is written down — and `tests/migrations.test.ts` pins the derived set, so a statement that stops being recognised fails the build rather than quietly reverting to a blocking build.

Use it for indexes on tables that already hold production data. A table created by the same migration is empty by definition and needs nothing.

## License

This project is licensed under the MIT License.

## Acknowledgements

- [Remix Icon](https://remixicon.com/) - Apache License 2.0
- [Bun](https://bun.sh) - JavaScript runtime
- [Solid](https://www.solidjs.com/) and [Elysia](https://elysiajs.com/) - Web UI and API framework
