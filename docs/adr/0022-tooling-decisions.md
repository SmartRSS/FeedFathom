# 0022 — Tooling: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Vendored shims

### Two dependencies are replaced by partial shims, guarded by a fidelity test

**Where:** `vendor/`; `vendor/__tests__/shim-fidelity.test.ts`; `package.json`, `overrides`

`fast-xml-parser` (reimplemented on Bun.XML for `@rowanmanning/feed-parser`) and `linkedom` (the browser's own DOMParser, for `@extractus/article-extractor`) are replaced by a few lines in `vendor/` instead of installed. Both implement only what their one dependent uses, so a dependency bump is the risk: a new API the shim lacks, or the real package landing nested under the dependent, fails only at runtime, as a crash on an untested feed or 189 KB of pure-JS DOM back in the SPA bundle. The fidelity test is that bump's alarm. It compares what the dependent resolves, not where the shim sits, because Bun may nest the shim itself since its lockfile records the override under the dependent; an empty set of imported names fails the test, because it means the regexes stopped matching.

### The fast-xml-parser shim implements only what feed-parser uses

**Where:** `vendor/fast-xml-parser-shim/index.js`, `XMLParser`, `XMLBuilder`; `vendor/fast-xml-parser-shim/__tests__/fast-xml-parser-shim.test.ts`

feed-parser uses `XMLParser` in preserveOrder mode and `XMLBuilder` to re-serialise an element's children for `innerHtml`. Nothing else is implemented, so a future feed-parser that reaches for `XMLValidator` or another option fails loudly instead of behaving differently. The expected shapes in the tests were captured from fast-xml-parser 5.10.1 configured as feed-parser configures it and matched byte for byte; the real package is not installed, so they are recorded rather than compared live. Comments and processing instructions are dropped, as the real parser does without `commentPropName`, and the adjacent text runs this leaves are merged; the builder escapes all five predefined entities and never self-closes. The one deliberate divergence: malformed XML throws, because Bun.XML is a conforming processor, where the real parser returned silently truncated data. The repo's own code calls Bun.XML through `src/features/feeds/xml.ts`, not through the shim.

### The linkedom shim needs an override and presents a fragment as its own document

**Where:** `vendor/linkedom-shim/index.js`, `fragmentView()`; `package.json`, `overrides.linkedom`

article-extractor only makes standard DOM calls and runs only in the browser (`src/spa/extension-reader.ts`), so the native DOMParser replaces linkedom. A direct `file:` dependency is not enough: it held only while a patchfile removed linkedom from article-extractor's dependencies, and when that patch stopped applying on a bump, Bun installed the real 2.6 MB package nested under article-extractor and the SPA bundle grew by 189 KB. The `overrides` entry does the same job with no version to keep in step. linkedom makes a fragment's root the `documentElement`, while the browser wraps it in `<html>`, `<head>` and `<body>`, and article-extractor 9.0.1 walks `documentElement.childNodes`, deleting head and body and returning nothing; so a fragment gets a view whose `documentElement` and `childNodes` are the fragment root, and everything else is the native document untouched.

## Lint plugin

### The oxlint plugin is JavaScript and resets per-file state in before()

**Where:** `tools/oxlint-plugin.js`, `createOnce`, `before()`

The plugin is JavaScript, not TypeScript, because oxlint's bin runs under `#!/usr/bin/env node` and the VS Code Oxc extension brings its own Node, so a .ts plugin fails on any Node before 22.18/20.19. Every rule uses `createOnce`, which runs once per lint run, not per file, so per-file state resets in `before()` and never in the `createOnce` body. Node type names are ESTree-standard (`MemberExpression`, not `StaticMemberExpression`).

### no-barrel-file catches named re-exports

**Where:** `tools/oxlint-plugin.js`, `noBarrelFile`

The built-in `oxc/no-barrel-file` counts only `export * from`, which this repo does not use. The local rule catches the named re-export form too, so the built-in cannot replace it.

### oxlint plugin tests run the real binary against temp fixtures

**Where:** `tools/__tests__/oxlint-plugin.test.ts`, `oxlintBin`

oxlint's own `RuleTester` needs raw-transfer support, which Bun does not provide, so the tests run the real linter against fixtures written to a temp directory. That also exercises plugin loading end to end and keeps the deliberately broken fixtures out of the repo's own lint run. The binary is resolved by absolute path, because with `cwd` in a temp directory `bunx` cannot see the project's node_modules and would fetch its own copy of oxlint.

## Lint configuration

### A rule is enabled only once the tree already passes it

**Where:** `.oxlintrc.json`, `rules`

Every rule was at zero violations against the tree in the commit that enabled it. The configuration locks in conventions the code already follows instead of scheduling a refactor, so adding a rule means measuring first and enabling only what is already true.

### no-barrel-file allows the drizzle-kit schema entry point

**Where:** `.oxlintrc.json`, `feedfathom/no-barrel-file`, `allow`; `src/platform/db/schema.ts`

`drizzle/config.json` names `src/platform/db/schema.ts` as its schema, and drizzle-kit discovers tables through it, so it is a barrel by necessity. Without it `generate` sees no tables and emits a DROP TABLE for every one of them.

### promise/always-return is off

**Where:** `.oxlintrc.json`, `promise/always-return`

The rule fires on a `.then()` that only has side effects, such as settling a deferred or awaiting a decode, where there is nothing to return. `typescript/no-floating-promises` already protects the value it guards.

### Async functions may be JSX event handlers

**Where:** `.oxlintrc.json`, `typescript/no-misused-promises`, `checksVoidReturn.attributes`

Solid ignores the promise an event handler returns, so the attribute check is off and an async function may be passed as a handler. Nothing awaits that promise, so the handler has to catch its own failures; no rule checks that. Every other void-return position still has to handle the promise.

### sort-keys is off where key order carries meaning

**Where:** `.oxlintrc.json`, the `sort-keys` override; `src/platform/db/schemas/**`, `src/platform/db/schema.ts`, `src/platform/config.ts`

A Drizzle table definition lists the id first and then the columns in the order the migration created them, and `configSchema` in `config.ts` keeps variables that interact next to each other. Sorting either alphabetically scatters the grouping that carries the meaning.

### Tool configs and the email Worker entry keep a default export

**Where:** `.oxlintrc.json`, the `import/no-default-export` override; `**/*.config.ts`; `src/features/mail-ingest/email-worker.ts`

The tools that load these configs and the Cloudflare Workers runtime require a default export.

### Tests may compile validators inline and use untyped values

**Where:** `.oxlintrc.json`, the two overrides for `**/__tests__/**` and `tests/**`

`feedfathom/schema-compile-module-scope` guards against recompiling a validator on a hot path, and a compile inside a test body runs once per run, so the cost it prevents cannot occur there. The five `typescript/no-unsafe-*` rules are off because tests assert directly on untyped values, such as response bodies and `page.evaluate` results: the `expect` call is the check, so narrowing the value first would only repeat it.

## Dev and packaging scripts

### Dev startup starts every service, then waits only on server and worker

**Where:** `bin/dev.ts`, `startup`; `.github/workflows/release-smoke.yml`, the start and wait steps

`docker compose up --wait` reports the migrator's clean exit(0) as a failure, and naming services does not help because a named service's dependencies are waited on too. So the script starts everything first, then waits only on the two services that stay up. Nothing is lost: the worker stays unready until the schema exists, so waiting for it to report healthy already waits for migrations to succeed.

### popup.html is packaged though the manifest does not name it

**Where:** `bin/generate-packages.ts`, `runtimePages`

No manifest entry names `popup.html`: `background-event.ts` sets it as the toolbar popup at runtime on browsers without a `contextMenus` API (ADR 0019). The packager lists it separately so it is not dropped as unused.

## CI workflows

### Untrusted values reach run scripts through env

**Where:** `.github/workflows/deploy-production.yml`, `deploy_email_worker`; `.github/workflows/release.yml`, `create_release`

A `${{ }}` expression is pasted into a script before the shell parses it, so dynamic values interpolated there can inject commands. Such values go into `env`, and the script reads them as variables. `deploy_email_worker` hands `MAIL_RELAY_SECRET` to jq as `$ENV.MAIL_RELAY_SECRET` rather than `--arg` for a second reason: the secret then never appears in a process argument list.

### Workflows are split by lifecycle

**Where:** `.github/workflows/ci.yml`, `release.yml`, `redeploy.yml`, `deploy-production.yml`, `pages.yml`

Pull requests run `ci.yml` on any target branch (so ad-hoc integration branches get full checks without triggering releases), with `pr_smoke` running in parallel with `quality`. Merges to `main` trigger `release.yml` (skipping `.dockerignore`-excluded docs and editor files) and auto-release; docs edits under `docs/**` trigger `pages.yml` directly. Manual rollbacks live in `redeploy.yml`, sharing `deploy-production.yml` with `release.yml` so the two paths never share a skipped-ancestor diamond or drift on production environment variables.

### Required checks are pinned by job name, and pr_gate always reports

**Where:** `.github/workflows/quality.yml`, the three job names; `.github/workflows/ci.yml`, `pr_gate`

The `main` ruleset pins required checks by context name, which for a reusable workflow is `<caller job> / <called job's name, or its id>`. Renaming a job, or adding or removing its `name:`, retires the check pinned to it, and every PR then waits on a check that can never report, so the job and the ruleset contexts change together. `bin/check-required-checks.ts` runs in the Lint job and fails when a required context matches no job that runs on `pull_request`. The ruleset pins `PR gate` rather than `pr_smoke`: `pr_smoke` needs registry credentials, which a pull request from a fork never receives, and a skipped reusable workflow never creates its nested job, so a check pinned to it would stay pending forever. `pr_gate` runs on `always()` and decides itself: quality must pass, and the image smoke must pass unless the pull request comes from a fork.

### Every job that runs steps has a timeout

**Where:** `timeout-minutes` on every step-running job in `.github/workflows/`

Each timeout sits well above the job's real runtime. A runner that hangs instead of failing would otherwise sit at GitHub's six-hour default, and `await_turn` holds every later run on `main` behind it, so one stuck job stalls the release queue.

### The Bun version comes from package.json and Playwright is cached by package version

**Where:** `.github/actions/bun-project/action.yml`, `bun-version-file`, `playwright-cache`; `package.json`, `packageManager`; `.github/workflows/release-smoke.yml`, "Select smoke browser"

CI reads the Bun version from `packageManager`, so local runs and CI cannot drift apart. Renovate is disabled in `.github/renovate.json`, so every extra pin would be maintained by hand. The Playwright browser cache is keyed on the installed `@playwright/test` version rather than `bun.lock`, so unrelated dependency bumps do not evict Chromium, and `ubuntu-latest` already ships Chromium's runtime libraries so `playwright install` skips `--with-deps`. The production smoke test loads no extension and uses the runner's preinstalled Chrome (`PLAYWRIGHT_CHANNEL=chrome`) when available.

### Unit tests run in full and browser tests run in parallel

**Where:** `.github/workflows/quality.yml`, `unit`, `browser`; `tests/browser/playwright.config.ts`

Full unit tests finish in under ten seconds, so running them in full on every pull request avoids a shallow-vs-deep checkout dance and keeps PR coverage identical to `main`. Playwright's `--only-changed` sees only what a spec imports statically, not the app code loaded over HTTP, so the browser job runs every spec with `fullyParallel: true` (and four workers in CI) so `spa.spec.ts` does not serialize on a single core.

### The lint job builds all targets, checks the deploy script, and caches TLA+

**Where:** `.github/workflows/quality.yml`, `lint`; `bin/model-check.sh`

`bun run build-project` finishes in a couple of seconds, so it runs inside `lint` instead of booting a separate runner. Running `shellcheck deploy/deploy.sh` in `lint` catches broken edits on the PR instead of mid-deploy. `tla2tools.jar` is cached by `bin/model-check.sh`'s hash, and `model-check.sh` runs all seven TLC configurations in parallel.

## Release pipeline

### Release versions are date fields offset so none needs a leading zero

**Where:** `.github/workflows/release.yml`, `build_metadata`

The version is the year minus 1900, then the day of the year plus 100, the minute of the day plus 1000, and the second plus 10. A WebExtension manifest version forbids a leading zero in any field, and the same string is the release tag and the images' `FEEDFATHOM_BUILD`, so each offset lifts its field above the range that would need padding and keeps it fixed-width. One job computes the version and the extension and image builds read its output, so separate `date` calls cannot disagree. The year field needs its offset too: a two-digit year falls from 99 to 0 in 2100, and browsers compare versions field by field, so no later build would update an installed extension. Minus 1900 gives 126 in 2026, above the 26 that every version issued with the two-digit year carries.

### Multi-arch images build natively on amd64 via docker buildx bake

**Where:** `Dockerfile`, `installer`, `builder-base`, `release`; `deploy/docker-bake.hcl`; `.github/workflows/release.yml`, `build_images`; `.github/workflows/release-smoke.yml`

`installer` and `builder-base` run on `$BUILDPLATFORM`, and the final `oven/bun:1.4.4-distroless` stage executes no `RUN` instructions (`--no-addons`, pure JS and SQL copies only). Building all three targets for `linux/amd64,linux/arm64` in a single `docker/bake-action` job on `ubuntu-latest` invokes zero QEMU emulation, deduplicates `installer` and `builder-base` in one BuildKit daemon, and pushes multi-arch manifests directly with no intermediate digest artifacts or separate manifest-assembly jobs. Each target keeps its own GHA cache scope so the three targets do not evict each other's layers.

### The image prefix is a literal

**Where:** `deploy/docker-bake.hcl`; `.github/workflows/release.yml`, `redeploy.yml`, `deploy-production.yml`, `env.IMAGE_PREFIX`

`compose.yml` and `deploy/compose.smoke.yml` hardcode `ghcr.io/smartrss/feedfathom`, so deriving the prefix per job from the repository name bought no portability.

### Quality runs in parallel with builds on main

**Where:** `.github/workflows/release.yml`, `quality`, `build_images`, `await_turn`

`main` enforces strict required status checks on PRs, so builds start immediately on push while `quality` runs alongside them as a sanity check. `await_turn` waits for both `quality` and `release_smoke`, so nothing promotes or deploys unless both pass.

### Deploys run in merge order through await_turn, not a concurrency group

**Where:** `.github/workflows/release.yml`, `await_turn`; `.github/workflows/redeploy.yml`, `await_turn`; `.github/workflows/deploy-production.yml`, `deploy`

Deploys run one at a time in merge order, while the jobs before them stay parallel. A `concurrency` group keeps only one pending run, so a third arrival cancels the second and drops the merge in the middle; that is how production once ended up on an arbitrary commit. `await_turn` in `release.yml` instead waits until no older run of `release.yml` on `main` is in flight: run ids rise monotonically per repository and a push creates its run when the merge lands, so a lower id is an earlier merge. Because a run counts as in flight for its whole lifetime, the wait is both the ordering and the mutual exclusion, with no lock that a cancelled job can leave behind; and because it is a job rather than a step in `deploy`, nothing holds the `production` group while it waits. A re-run keeps its original id, and the ancestry check in `deploy` stops it rolling production back. `redeploy.yml` waits for any in-flight `release.yml` runs on `main` and any older `redeploy.yml` runs before calling `deploy-production.yml`, which also holds the shared `production` concurrency group.

### Production does not roll backwards on a push

**Where:** `.github/workflows/deploy-production.yml`, `deploy`, "Refuse to roll production backwards", "Checkout deploy script"

`await_turn` orders merges; this step is the backstop for what it cannot see, such as a re-run of an older pipeline or a gate that timed out, on the one action that is not cheap to undo. It reads the live commit from the Swarm service itself, because the running service is the only record that cannot disagree with what is deployed, and stands down when GitHub's compare reports `behind` or `identical`. `diverged`, after a revert or a force-push, still deploys, because moving forward is the intent. Manual redeploys pass `refuse_rollback: false` so rollbacks are allowed. The deploy script comes from the workflow's own commit, not from `deploy_tag`, because a manual redeploy can target a commit older than the script.

### Jobs below a join that runs past a skipped need check their needs' results

**Where:** `bin/__tests__/workflow-skipped-ancestors.test.ts`

An `if:` that names no status function is an implicit `success()`, which is false when any ancestor was skipped. Splitting `release.yml` and `redeploy.yml` removed the skipped-ancestor join from the release pipeline, and `workflow-skipped-ancestors.test.ts` remains as a guardrail against reintroducing one.

### The email Worker never deploys over a newer server

**Where:** `.github/workflows/deploy-production.yml`, `deploy_email_worker`

`docs/running.md` records why the Worker deploys after `deploy` and how its content hash works. The job also stands down when `deploy` did: a deploy that found production already on a newer commit reports success with `skipped`, and uploading this run's Worker then would put an older relay in front of a newer server. The hash rides on the script as a `content:` tag, so Cloudflare itself records what is deployed, and unlike a runner cache that record cannot go stale or differ between branches. The Worker answers no HTTP request, because its bundle exports only an `email` handler, so the final settings call, which checks the tag and the exact binding names, is the check that the right artifact landed.

### The extension is re-signed only when its shipped bytes change

**Where:** `.github/workflows/release.yml`, `build_extension`, "Detect whether the extension actually changed"

The hash covers the built files of both variants, not the source paths that feed them: the bundle pulls in `src/shared/scanners/**` as well as `src/extension/**`, so a `paths:` filter would miss changes that arrive through shared code, and code that tree-shaking drops correctly does not count. Each manifest's `version` is excluded, because it is stamped fresh on every run. The last published hash travels as an asset of the release that published it, so no Actions cache is needed. The lookup reads every page of non-draft, non-prerelease releases so a match older than one page of 100 releases is still found and never triggers a redundant AMO signing.

### Release notes start at the last stable release

**Where:** `.github/workflows/release.yml`, `create_release`

Notes are generated from the last non-draft, non-prerelease release so historical prereleases never truncate stable release notes. A release whose extension is unchanged carries no extension assets: the previous release already has that exact build, and the docs site still serves it.

### The docs site publishes on docs edits and extension changes

**Where:** `.github/workflows/pages.yml`; `.github/workflows/release.yml`, `pages`

`pages.yml` runs on `push` to `main` touching `docs/**` so docs edits go live quickly without triggering Docker builds or Swarm rollouts, and `release.yml` calls `pages.yml` after `await_turn` whenever `build_extension` produced a newly signed extension. A run that built no extension copies the XPI, ZIP and CRX from the newest stable release that has them, and reads the version and build date from that XPI's own manifest and release so every install link and update manifest agrees with the copied bytes. That lookup reads every page of releases so an unchanged extension older than one page of 100 releases never breaks a docs deploy.
