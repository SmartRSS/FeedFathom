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

Development setup and the full command reference are in
[Running the application](./running.md).

## License

FeedFathom is licensed under the MIT License.
