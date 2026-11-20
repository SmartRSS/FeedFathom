---
name: delete-comment
description: Audit the comments in a path, delete them, file issues for excuses, move decisions into ADRs, and lower the comment budget.
disable-model-invocation: true
argument-hint: "[path ...] (default: the whole tree)"
---

Remove every prose comment from the paths in `$ARGUMENTS` (the whole tree if
empty). Each comment leaves the code in one of three ways, and none stays
behind. ADR 0023 records why.

## 1. List the comments

- **TS, TSX, linted JS:** remove the files' entries from the `budget` of
  `feedfathom/no-comments` in `.oxlintrc.json`, then run `bun run oxlint`.
  The rule now reports every comment in those files.
- **Everything else** (CSS, YAML, Dockerfile, shell, JSONC, HTML, and the
  files `.oxlintrc.json` ignores): read the files.

Directives are not prose. Leave `oxlint-disable…`, `eslint-disable…`,
`@ts-expect-error`, `/// <reference>`, `@__PURE__` and JSDoc type tags in `.js`
files in place. A directive line can sit inside a run of prose comment lines,
so delete line by line, never the whole block at once. When a directive's
`-- reason` points at prose you delete ("see above"), rewrite the reason as
one line that stands alone.

Done when you have the full list of comment blocks in scope.

## 2. Classify each block

Each block gets exactly one category:

- **Tautology:** says what the code, a name, a type or a signature already says.
  Banners, Arrange/Act/Assert, a docblock that rephrases the function name.
- **Stale:** describes code, files, behaviour or issues that are gone. Grep a
  name before you call it current. Change narration ("now", "no longer",
  "previously") is stale: the reader has the file, not the diff.
- **Excuse:** lets a hack stand that this repo could write properly. Signs:
  "for now", "TODO", "workaround", a swallowed error, a cast justified in
  prose, a sleep in a test, known duplication.
- **Decision record:** an important, non-obvious reason: a constraint, an
  invariant, an outside quirk (browser, protocol, library, PostgreSQL), a
  rejected alternative. A workaround for something the repo cannot change is
  a decision record, not an excuse.

The tie-breaker between tautology and decision record: would a competent
newcomer reading only the code change it wrongly? If not, it is tautology. A
comment that repeats `CONTEXT.md` or an ADR is tautology.

Done when every block has a category.

## 3. Act

- **Tautology, Stale:** delete it.
- **Excuse:** delete it and file an issue as `docs/agents/issue-tracker.md`
  describes, labelled `needs-triage`. Name the file and symbol (never a line
  number), what the code does, why it is a hack, and what a proper fix looks
  like. Merge excuses that share one fix into one issue. Search open issues
  first.
- **Decision record:** delete it and write it into the ADR for its area:
  0008 feeds, 0009 auth, 0010 reader, 0011 mail-ingest, 0012 jobs,
  0013 platform-http, 0014 platform-db (and `src/migrator.ts`),
  0015 platform-runtime, 0016 shared, 0017 spa, 0018 service-worker,
  0019 extension, 0020 server-composition, 0021 testing, 0022 tooling.
  Grep `docs/adr/` for the file path first, and extend an existing entry
  rather than adding a near-duplicate. A new entry goes under the fitting
  `##` topic:

  ```markdown
  ### <Title that states the decision>

  **Where:** `path`, `symbol`

  <One to four sentences: the decision, the reason, what breaks if it is undone.>
  ```

  A decision big enough to stand alone gets its own numbered ADR instead.

Delete only comments: no renames and no refactors in the same change. Leave no
doubled blank line and no empty `{}` JSX expression where a comment stood.

Done when every block is deleted and every excuse and decision record has its
issue or ADR entry.

## 4. Ratchet and verify

1. For each linted file you could not finish, set its `budget` entry to the
   number of comments it still has. Drop entries that reach zero. Never raise
   a budget.
2. Run `bun run format:fix`, then `bun run lint` and `bun run test:unit`. All
   must pass.
3. Count the directives before and after (`git grep -c -E
   '(oxlint|eslint)-(disable|enable)|@ts-expect-error|__PURE__'`). The counts
   must match, apart from directives you meant to change.

Done when lint and tests are green and the directive count matches.

## Large scopes

Beyond about 300 comment blocks, split the files into slices by directory and
give each slice to a subagent in its own worktree, with steps 1 to 3 as its
brief. Each subagent deletes the comments in its slice, commits, and returns
its excuses and decision records as text instead of filing or writing them.
You then cherry-pick the commits, dedupe and file the issues, merge the
decision records into the ADRs, and run step 4 once.
