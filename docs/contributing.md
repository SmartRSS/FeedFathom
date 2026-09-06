---
layout: default
title: Contributing
nav_order: 4
---

# Contributing to FeedFathom

## Submitting a change

1. Fork the repository and create a branch:

   ```bash
   git checkout -b feature-branch-name
   ```

2. Make the change. Match the existing code style, add tests for new
   behaviour, and update the documentation the change affects.

3. Run the complete gate. It covers unit tests, real Chromium tests,
   formatting, Oxlint, TypeScript, Knip, and every production build target.

   ```bash
   bun run quality
   ```

4. Commit and push:

   ```bash
   git commit -m 'Add feature'
   git push origin feature-branch-name
   ```

5. Open a pull request.

Keep commits focused. A commit that mixes a refactor with a behaviour change
is harder to review and harder to revert.

## While iterating

```bash
bun run test:unit
bun run test:browser
bun run lint
bun run lint:fix
```

Browser tests require the Chromium binary. Install it once:

```bash
bunx playwright install chromium
```

`bun run quality` does not cover the integration tests, which need a real
PostgreSQL and only run in CI unless you point them at one. Anything touching
the schema, a migration or a query is worth running them against:

```bash
docker run -d --rm --name feedfathom-test-db -p 55432:5432 \
  -e POSTGRES_PASSWORD=postgres postgres:17-alpine
docker exec feedfathom-test-db psql -U postgres -c 'CREATE DATABASE feedfathom_migration_test'
MIGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/feedfathom_migration_test \
  bun run test:migrations
```

These tests drop the `public` schema before every run, so the URL is checked
first and rejected unless the database name carries a `test` or `disposable`
marker. Never point them at a database you care about.

## A second checkout at the same time

`bun run dev` starts one Compose project named `feedfathom`, publishes the
API on `127.0.0.1:3001` and gives Vite `127.0.0.1:3456`. All three are fixed
by default, so running it from a second checkout or a git worktree takes the
first stack's containers over rather than starting its own — and `bun run
dev:down` from either one stops the same stack.

To run a second stack beside the first, give it its own name and its own two
ports:

```bash
COMPOSE_PROJECT_NAME=feedfathom-wt \
FEEDFATHOM_DEV_API_PORT=3011 \
FEEDFATHOM_DEV_SPA_PORT=3466 \
  bun run dev
```

`COMPOSE_PROJECT_NAME` outranks the `name:` in the overlay, so the second
stack gets its own containers, network and volumes — including its own
PostgreSQL, which means its own accounts and subscriptions. Pass the same
three variables to `bun run dev:down`.

Development setup and the full command reference are in
[Running the application](./running.md).

## License

FeedFathom is licensed under the MIT License.
