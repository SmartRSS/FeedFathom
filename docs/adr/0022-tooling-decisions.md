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

## Dev and packaging scripts

### Dev startup starts every service, then waits only on server and worker

**Where:** `bin/dev.ts`, `startup`

`docker compose up --wait` reports the migrator's clean exit(0) as a failure, and naming services does not help because a named service's dependencies are waited on too. So the script starts everything first, then waits only on the two services that stay up. Nothing is lost: the worker stays unready until the schema exists, so waiting for it to report healthy already waits for migrations to succeed.

### popup.html is packaged though the manifest does not name it

**Where:** `bin/generate-packages.ts`, `runtimePages`

No manifest entry names `popup.html`: `background-event.ts` sets it as the toolbar popup at runtime on browsers without a `contextMenus` API (ADR 0019). The packager lists it separately so it is not dropped as unused.
