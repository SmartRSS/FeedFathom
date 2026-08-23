## Architecture

Read `CONTEXT.md` at the repo root before creating a file. It states the four
layers, the declared feature DAG, and the one-sentence rule for where a new
file goes:

> Put a file in the feature that owns the behaviour it implements. If more than
> one feature owns it, it belongs in `platform` (infrastructure) or `shared`
> (contracts, types, dependency-free helpers) — not in a third feature.

Cross-directory imports use the `#shared/*`, `#platform/*` and `#features/*`
subpath imports, with the `.ts` suffix. `feedfathom/layer-boundaries` in
`tools/oxlint-plugin.js` fails CI on an import that runs upward or sideways
into an undeclared feature; adding a feature-to-feature edge means editing that
rule's options in `.oxlintrc.json`.

Unit tests are co-located next to the module they cover. `tests/` holds only
what tests something other than a `src/` module: the Playwright specs, the
drizzle migration tests, the vendored shim, and the `bin/` and `tools/` tests.

Decisions live in `docs/adr/`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (SmartRSS/FeedFathom), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
