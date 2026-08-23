# 0001 — Feature-first layering with an enforced dependency direction

- **Status:** accepted
- **Date:** 2026-08-23

## Context

The code works; the directory layout no longer describes it. The tree was
shaped by successive rounds of patching rather than by a decision anyone wrote
down.

**There was no dependency direction.** `import/no-cycle` passed, so nothing was
circular at the file level, but at the directory level nothing was layered
either. `contracts/` imported from `lib/`. `db/data-services/` imported from
`contracts/`, `lib/`, `types/` and `util/`. `lib/` imported from
`db/data-services/` in three modules. Every group reached into every other, so
there was no rule an author — human or agent — could apply to decide where a
new file went.

**`src/lib/` was a dumping ground.** Thirty files sharing nothing but not being
obviously a route or a table: the HTTP client, the feed parsers, thirteen site
scanners, the OPML parser, WebSub, the email handler, the worker main loop —
and `lib/images/icons/*.svg`, SolidJS components imported exclusively by the
SPA. A frontend asset directory inside a nominally server-side utility folder.

**Two grouping strategies ran at once.** `routes/` was organised by feature;
`db/data-services/` and `lib/` by kind. One feature was smeared across four
trees, so adding a feature meant touching four directories and guessing at
each.

**The document that would fix this did not exist.** `CLAUDE.md` promised a root
`CONTEXT.md` and `docs/adr/`. Neither was present. That absence is the direct
cause of the drift: with nothing to consult, file placement defaults to "next
to something that looked related."

## Decision

Adopt a feature-first layout with four layers — `shared`, `platform`,
`features/*`, and the clients `spa` and `extension` — each allowed to depend
only downward, with entrypoints at the `src/` root as composition roots. The
features are `auth`, `feeds`, `reader`, `admin`, `mail-ingest` and `jobs`, and
the allowed feature-to-feature edges are written down as a DAG.

Cross-directory imports use package.json subpath imports (`#shared/*`,
`#platform/*`, `#features/*`).

The rule is captured twice: in prose in `CONTEXT.md`, and as the
`feedfathom/layer-boundaries` rule in `tools/oxlint-plugin.js` so a violating
import fails CI.

`CONTEXT.md` holds the current statement of the layout. This ADR records why.

## Alternatives considered

**Layer-first with an enforced direction** (`routes/`, `services/`, `domain/`,
`infra/`). Rejected: `routes/` is already organised by feature, and the pain
being reported is precisely that one feature's code is scattered across trees.
Layer-first would formalise the scattering instead of ending it.

**A cycles-only minimal fix** — break the three backward edges, change nothing
else. Rejected: it leaves `lib/` a grab-bag and leaves the placement question
unanswered, so the drift resumes immediately. It treats the symptom.

**Merging `reader` into `feeds`** as one large feature. Rejected: they have
genuinely different jobs — discovering and fetching a feed versus reading what
came out of it — and the merged feature would be by far the largest thing in
the tree, which is the grab-bag problem again at a different scale. Keeping
them apart and declaring `reader → feeds` makes the dependency visible instead
of dissolving it.

## Consequences

- Adding a cross-feature dependency requires editing the declared DAG, so it
  surfaces in review as a config change rather than as a quiet new import.
- A feature's routes, data services and domain logic live together, so a change
  to one feature touches one directory.
- Unit tests are co-located with the modules they cover, which restores the
  module-to-test mapping that a flat `tests/` directory had lost.
- The refactor itself is a long series of behaviour-preserving moves. Every
  commit leaves `lint`, `test:unit` and `build-project` green, so a red build
  points at exactly one move.

### Two placements that differ from the first sketch

**The scanners live in `shared`, not in `features/feeds`.** `src/extension/`
imports `scan` itself, not merely a type from it, and the scanner tree has no
dependency on anything else inside `src/`. Under "clients depend on `shared`
only" the choices were to put the scanners in `shared` or to give the extension
its own copy of fourteen files. Duplication for the sake of a diagram is worse
than either. The scanners are a dependency-free feed-discovery library used by
both the server and the extension, which is what `shared` is for.

**`private-network-guard.ts` lives in `shared/net/`, not in `platform/http/`.**
Same reasoning: `src/extension/reader-fetch.ts` imports `isBlockedHostname`,
and the module depends on nothing. The alternative — letting clients import
`platform` — would also let the extension import the database connection, which
is exactly what the client rule exists to prevent.
