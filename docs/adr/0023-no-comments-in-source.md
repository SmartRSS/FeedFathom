# 0023 — Source code carries no comments

- **Status:** accepted
- **Date:** 2026-11-20

## Context

An audit of every comment in the TS, TSX and JS source found 1,959 comment
blocks, about 5,370 lines, or a tenth of the 55,600 lines in those files:

| Kind | Blocks | Lines |
| --- | --- | --- |
| Tautology: repeats what the code already says | 947 | 1,822 |
| Stale: describes code or behaviour that is gone | 31 | 87 |
| Excuse: lets a hack stand | 9 | 26 |
| Decision record: an important, non-obvious reason | 971 | 3,431 |

Half of the comment lines told the reader nothing the code did not. The
excuses kept workarounds in place that nobody had been asked to fix. The
decision records were the valuable half, but they were scattered across 297
files, they were invisible to anyone who had not opened the right file, and a
few contradicted each other.

## Decision

Source files carry no prose comments. Each kind of comment has its own home:

- A tautology or a stale comment is deleted.
- An excuse is deleted, and the hack becomes a GitHub issue.
- A decision record moves to an ADR. ADRs 0008 to 0022 hold the decisions
  that were comments, one file per area, each entry naming the file and symbol
  it governs.

Directives are not prose and stay: `oxlint-disable…` and `eslint-disable…`
with a one-line `-- reason`, `@ts-expect-error -- reason`, `/// <reference>`,
`@__PURE__`, and JSDoc type tags in `.js` files.

`feedfathom/no-comments` in `tools/oxlint-plugin.js` enforces this. Its
`budget` option in `.oxlintrc.json` is a ratchet for code that still carries
comments: it maps a path suffix to the number of comments the file may keep.
A file over its budget fails, and so does a file under it, so each deletion
must lower the budget and a deleted comment cannot come back. A file with no
budget entry may hold no comments. The budget is empty, because the first
pass removed every comment in linted files.

The `/delete-comment` skill in `.claude/skills/delete-comment/` repeats the
audit for any part of the tree.

## Consequences

- To learn why code has its shape, search `docs/adr/` for the file path.
  Renaming or moving a file or symbol means updating the ADR entries that
  name it.
- A lint directive's `-- reason` is the only explanation that sits next to
  the code, so it has to stand alone on one line.
- The rule covers only the files oxlint lints. `tools/oxlint-plugin.js`, the
  vendor shims (`**/*.js` is ignored), `bin/**` and `vite.config.ts` lost their
  comments in the same pass but are not checked. Files in other languages are
  outside the rule and still carry comments: the two stylesheets (788 lines),
  the YAML workflows, `compose.yml`, the Dockerfile and shell scripts (523
  lines), `.oxlintrc.json` (32 lines), and `src/spa/index.html` (10 lines). The
  SQL migrations (32 lines) are history and keep theirs.

## Alternatives considered

**Allow comments that explain why.** This is the usual rule, and it is the rule
that produced the tree above: authors classed most comments as "why", including
the tautologies and the excuses. Deciding which comment earns its place takes
judgement on every review. A ban takes none, and the ADRs give the reasons a
place where they can be read together.

**Ban comments without a budget.** Code that already carries comments could not
adopt the rule until every comment in it was resolved. The budget lets the ban
apply at once and shrink the remainder one file at a time.
