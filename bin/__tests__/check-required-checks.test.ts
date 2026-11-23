import { expect, test } from "bun:test";
import { unproducedChecks } from "../check-required-checks.ts";

const ruleset = {
  contexts: ["quality / build", "Merges into main come from staging"],
  name: "lint and verify",
};

function workflows(
  qualityJobs: Record<string, { name?: string }>,
  guardTrigger: object = { pull_request: { branches: ["main"] } },
) {
  return new Map([
    [
      ".github/workflows/docker-build.yml",
      {
        jobs: { quality: { uses: "./.github/workflows/quality.yml" } },
        on: { pull_request: null, push: null },
      },
    ],
    [
      ".github/workflows/quality.yml",
      { jobs: qualityJobs, on: { workflow_call: null } },
    ],
    [
      ".github/workflows/branch-guard.yml",
      {
        jobs: { source_branch: { name: "Merges into main come from staging" } },
        on: guardTrigger,
      },
    ],
  ]);
}

test("a reusable workflow's job reports as caller / called", () => {
  expect(unproducedChecks([ruleset], workflows({ build: {} }))).toEqual([]);
});

test("renaming a required job reports the check it retires", () => {
  const problems = unproducedChecks(
    [ruleset],
    workflows({ compile: { name: "Compile every deployable target" } }),
  );
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('"quality / build"');
});

test("a job that never runs on pull_request reports no check", () => {
  const pushOnly = workflows({ build: {} }, { push: null });
  expect(unproducedChecks([ruleset], pushOnly)).toHaveLength(1);
});
