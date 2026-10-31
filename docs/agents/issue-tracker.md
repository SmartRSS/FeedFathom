# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Fixes merged into staging

GitHub closes an issue from `Closes #N` only when the PR merges into `main`, and fixes merge into `staging`. Automation fills that gap:

- In a PR into `staging`, write `Closes #N` (or `Fixes`/`Resolves`) when the PR completes the issue, and `Refs #N` when it is partial work.
- When the PR merges, `staging-issues.yml` adds the `on-staging` label to every issue it closes. Do not add or remove the label by hand.
- After a production deploy, the Release Pipeline closes each `on-staging` issue once every merged PR that references it is in the deployed commit.
