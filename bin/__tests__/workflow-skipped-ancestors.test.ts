import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

type Job = { if?: unknown; needs?: string | string[] };
type Workflow = { jobs?: Record<string, Job> };

const workflowDirectory = ".github/workflows";

function runsPastSkippedNeed(job: Job | undefined): boolean {
  return (
    typeof job?.if === "string" && /always\(\)|!\s*cancelled\(\)/.test(job.if)
  );
}

function needsOf(job: Job | undefined): string[] {
  if (job?.needs === undefined) return [];
  return typeof job.needs === "string" ? [job.needs] : job.needs;
}

function joinAbove(jobs: Record<string, Job>, id: string): string | undefined {
  for (const need of needsOf(jobs[id])) {
    if (runsPastSkippedNeed(jobs[need])) return need;
    const join = joinAbove(jobs, need);
    if (join !== undefined) return join;
  }
  return undefined;
}

test("a job below a join that runs past a skipped need checks its needs' results itself", async () => {
  const problems: string[] = [];
  for (const file of await readdir(workflowDirectory)) {
    const path = `${workflowDirectory}/${file}`;
    const workflow = Bun.YAML.parse(await Bun.file(path).text()) as Workflow;
    const jobs = workflow.jobs ?? {};
    for (const [id, job] of Object.entries(jobs)) {
      const join = joinAbove(jobs, id);
      if (join === undefined || runsPastSkippedNeed(job)) continue;
      problems.push(
        `${path}: job "${id}" runs below "${join}", which runs past a skipped need, so "${id}" has a skipped ancestor whenever "${join}" does. An if: without always() or !cancelled() is an implicit success(), which is false whenever an ancestor was skipped, so "${id}" would be skipped too. Start its if: with !cancelled() and require needs.<job>.result == 'success' for each need. ADR 0022 records why.`,
      );
    }
  }
  expect(problems).toEqual([]);
});
