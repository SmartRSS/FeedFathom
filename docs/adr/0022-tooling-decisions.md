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

**Where:** `.github/workflows/branch-guard.yml`, `source_branch`; `.github/workflows/staging-issues.yml`, `label`; `.github/workflows/docker-build.yml`, `deploy_email_worker`

A `${{ }}` expression is pasted into a script before the shell parses it, so a branch name, PR title or PR body interpolated there can inject commands. Such values go into `env`, and the script reads them as variables. `deploy_email_worker` hands `MAIL_RELAY_SECRET` to jq as `$ENV.MAIL_RELAY_SECRET` rather than `--arg` for a second reason: the secret then never appears in a process argument list.

### Merges into main come only from this repository's staging

**Where:** `.github/workflows/branch-guard.yml`, `source_branch`

Main is promoted from staging only. A ruleset can require checks and a pull request, but it has no rule for which branch a pull request comes from, so the rule is a status check that the main ruleset requires. It checks the head repository as well as the branch name, because a fork can have its own branch called `staging`.

### Required checks are pinned by job name, and pr_gate always reports

**Where:** `.github/workflows/quality.yml`, the four job names; `.github/workflows/branch-guard.yml`, `source_branch`; `.github/workflows/docker-build.yml`, `pr_gate`

The main and staging rulesets pin required checks by context name, which for a reusable workflow is `<caller job> / <called job's name, or its id>`. Renaming a job, or adding or removing its `name:`, retires the check pinned to it, and every PR then waits on a check that can never report, so the job and the ruleset contexts change together. The rulesets pin `PR gate` rather than `pr_smoke`: `pr_smoke` needs registry credentials, which a pull request from a fork never receives, and a skipped reusable workflow never creates its nested job, so a check pinned to it would stay pending forever. `pr_gate` runs on `always()` and decides itself: quality must pass, and the image smoke must pass unless the pull request comes from a fork.

### Every job that runs steps has a timeout

**Where:** `timeout-minutes` on every step-running job in `.github/workflows/`

Each timeout sits well above the job's real runtime. A runner that hangs instead of failing would otherwise sit at GitHub's six-hour default, and `await_turn` holds every later run on the branch behind it, so one stuck job stalls the release queue.

### The Bun version comes from package.json

**Where:** `.github/actions/bun-project/action.yml`, `bun-version-file`; `package.json`, `packageManager`

CI reads the version from `packageManager`, so local runs and CI cannot drift apart. Renovate is disabled in `.github/renovate.json`, so every extra pin would be maintained by hand.

### On a pull request, unit tests follow the changed import graph and browser tests run in full

**Where:** `.github/workflows/quality.yml`, `unit`, `browser`

Unit tests import what they test statically, so `bun test --changed`, which walks that import graph, selects every unit test a change can affect. Playwright's `--only-changed` sees only what a spec imports statically, not the app code the browser loads over HTTP, so the browser job runs every spec on every trigger.

### The lint job checks the deploy script

**Where:** `.github/workflows/quality.yml`, `lint`, "Check deploy script"

`deploy/deploy.sh` runs only in a main release. Running shellcheck on it in the lint job makes a broken edit fail on staging instead of mid-deploy.

## Release pipeline

### Release versions are date fields offset so none needs a leading zero

**Where:** `.github/workflows/docker-build.yml`, `build_metadata`

The version is the two-digit year, then the day of the year plus 100, the minute of the day plus 1000, and the second plus 10. A WebExtension manifest version forbids a leading zero in any field, and the same string is the release tag and the images' `FEEDFATHOM_BUILD`, so each offset lifts its field above the range that would need padding and keeps it fixed-width. One job computes the version and the extension and image builds read its output, so separate `date` calls cannot disagree. The year has no offset yet (#1191).

### Each architecture builds on its own runner and pushes by digest

**Where:** `.github/workflows/docker-build.yml`, `build_platform_images`, `publish_images`

Under QEMU an arm64 build takes the Bun build from about a minute to most of an hour, so each architecture runs on a native runner. Each leg pushes an unnamed image by digest, and the tag appears only on the manifest that `publish_images` assembles from both; it refuses to assemble one with a single architecture, which would strand whichever node runs the other and which `promote` would copy on. The build cache is scoped per target and architecture, because with one shared scope the three targets evict each other's layers on every run.

### The image prefix is a literal

**Where:** `.github/workflows/docker-build.yml`, `env.IMAGE_PREFIX`

`compose.yml` and `deploy/compose.smoke.yml` hardcode `ghcr.io/smartrss/feedfathom`, so deriving the prefix per job from the repository name bought no portability.

### The push and dispatch paths call the smoke workflow from separate jobs

**Where:** `.github/workflows/docker-build.yml`, `release_smoke_push`, `release_smoke_dispatch`

Each caller's only need runs on exactly one event, so neither needs an `if:`: a skipped or failed need skips it. One shared caller would put `validate_deploy_tag`, which runs only on dispatch, into every push run's chain as a skipped job, and every job after it, `promote` and `create_release` among them, would need `always()` to survive that skip.

### Deploys run in merge order through await_turn, not a concurrency group

**Where:** `.github/workflows/docker-build.yml`, `await_turn`

Deploys run one at a time in merge order, while the jobs before them stay parallel. A `concurrency` group keeps only one pending run, so a third arrival cancels the second and drops the merge in the middle; that is how production once ended up on an arbitrary commit. `await_turn` instead waits until no older run of this workflow on the same branch is in flight: run ids rise monotonically per repository and a push creates its run when the merge lands, so a lower id is an earlier merge, and filtering on the branch keeps staging and main in separate queues and leaves PR runs out. Because a run counts as in flight for its whole lifetime, the wait is both the ordering and the mutual exclusion, with no lock that a cancelled job can leave behind; and because it is a job rather than a step in `deploy`, nothing holds the `production` group while it waits. A re-run keeps its original id, and the ancestry check in `deploy` stops it rolling production back. A dispatch run does not pass this gate (#1192).

### Production does not roll backwards on a push

**Where:** `.github/workflows/docker-build.yml`, `deploy`, "Refuse to roll production backwards", "Checkout deploy script"

`await_turn` orders merges; this step is the backstop for what it cannot see, such as a re-run of an older pipeline or a gate that timed out, on the one action that is not cheap to undo. It reads the live commit from the Swarm service itself, because the running service is the only record that cannot disagree with what is deployed, and stands down when GitHub's compare reports `behind` or `identical`. `diverged`, after a revert or a force-push, still deploys, because moving forward is the intent. The deploy script comes from the workflow's own commit, not from `deploy_tag`, because a dispatch can redeploy a commit older than the script.

### Jobs below a join that runs past a skipped need check their needs' results

**Where:** `.github/workflows/docker-build.yml`, `deploy`, `deploy_email_worker`, `close_released_issues`; `bin/__tests__/workflow-skipped-ancestors.test.ts`

`promote` (push) and `release_smoke_dispatch` (dispatch) are alternate paths, so one of `deploy`'s needs is skipped on every run; `deploy` runs on `!cancelled()`, not `always()`, and requires one of them to have succeeded, which transitively requires quality, the image publish or validation, and the smoke. An `if:` that names no status function is an implicit `success()`, which is false when any ancestor was skipped, so a job below `deploy` with a bare `needs: deploy` never runs: `deploy_email_worker` shipped that way, and its first production run did nothing. The test fails any job below such a join whose `if:` has neither `always()` nor `!cancelled()`.

### The email Worker never deploys over a newer server

**Where:** `.github/workflows/docker-build.yml`, `deploy_email_worker`

`docs/running.md` records why the Worker deploys after `deploy` and how its content hash works. The job also stands down when `deploy` did: a deploy that found production already on a newer commit reports success with `skipped`, and uploading this run's Worker then would put an older relay in front of a newer server. The hash rides on the script as a `content:` tag, so Cloudflare itself records what is deployed, and unlike a runner cache that record cannot go stale or differ between branches. The Worker answers no HTTP request, because its bundle exports only an `email` handler, so the final settings call, which checks the tag and the exact binding names, is the check that the right artifact landed.

### Released issues close once production contains every PR that references them

**Where:** `.github/workflows/docker-build.yml`, `close_released_issues`

`docs/agents/issue-tracker.md` describes the `on-staging` flow. A deploy that stood down because production already runs a newer commit still closes issues, because that commit contains this one.

### The extension is re-signed only when its shipped bytes change, compared per channel

**Where:** `.github/workflows/docker-build.yml`, `build_extension`, "Detect whether the extension actually changed"

The hash covers the built files of both variants, not the source paths that feed them: the bundle pulls in `src/shared/scanners/**` as well as `src/extension/**`, so a `paths:` filter would miss changes that arrive through shared code, and code that tree-shaking drops correctly does not count. Each manifest's `version` is excluded, because it is stamped fresh on every run. The last published hash travels as an asset of the release that published it, so no Actions cache is needed; caches do not cross sibling branches. Staging compares against prereleases and main against stable releases, because comparing across channels made every main run report "unchanged" (staging always publishes the same content first), and the docs site then stayed on an old extension while new builds shipped from staging. The lookup reads only the newest 100 releases (#1193).

### Release notes start at the last stable release

**Where:** `.github/workflows/docker-build.yml`, `create_release`

Notes are generated from the last stable release, not the last staging prerelease, so staging prereleases stay cumulative until promoted and a stable release's notes are not cut short by a prerelease in between. A release whose extension is unchanged carries no extension assets: the previous release already has that exact build, and the docs site still serves it.

### The docs site republishes on every main push, after older runs

**Where:** `.github/workflows/docker-build.yml`, `pages`

The site is rendered from scratch each run, so every push to main republishes it; gating it on an extension rebuild meant a docs-only commit never reached the site. It needs `await_turn`, so an older run cannot republish over a newer one and leave the docs describing a commit production has moved past. A run that built no extension takes the XPI, ZIP and CRX from the newest stable release that has them, or the deploy would drop the files that every install link and update check points at; the version and build date then come from that XPI's own manifest and release, the only sources that agree with the copied bytes. That lookup reads only the newest 100 releases (#1193).
