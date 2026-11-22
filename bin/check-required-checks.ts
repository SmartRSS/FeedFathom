import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type Job = { name?: unknown; uses?: unknown };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };
export type Ruleset = { name: string; contexts: string[] };

const workflowDirectory = ".github/workflows";
const repository = "SmartRSS/FeedFathom";

function runsOnPullRequests(workflow: Workflow): boolean {
  const triggers = workflow.on;
  if (typeof triggers === "string") return triggers === "pull_request";
  if (Array.isArray(triggers)) return triggers.includes("pull_request");
  return typeof triggers === "object" && triggers !== null
    ? "pull_request" in triggers
    : false;
}

function jobTitle(id: string, job: Job): string {
  return typeof job.name === "string" ? job.name : id;
}

export function producedContexts(
  workflows: Map<string, Workflow>,
): Set<string> {
  const contexts = new Set<string>();
  for (const workflow of workflows.values()) {
    if (!runsOnPullRequests(workflow)) continue;
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      const caller = jobTitle(id, job);
      const called =
        typeof job.uses === "string"
          ? workflows.get(job.uses.replace(/^\.\//, ""))
          : undefined;
      if (called === undefined) {
        contexts.add(caller);
        continue;
      }
      for (const [calledId, calledJob] of Object.entries(called.jobs ?? {})) {
        contexts.add(`${caller} / ${jobTitle(calledId, calledJob)}`);
      }
    }
  }
  return contexts;
}

export function unproducedChecks(
  rulesets: Ruleset[],
  workflows: Map<string, Workflow>,
): string[] {
  const produced = producedContexts(workflows);
  return rulesets.flatMap((ruleset) =>
    ruleset.contexts
      .filter((context) => !produced.has(context))
      .map(
        (context) =>
          `Ruleset "${ruleset.name}" requires the check "${context}", but no job that runs on pull_request reports it. A reusable workflow's check is "<caller job name or id> / <called job name or id>". Restore the job's id or name, or change the ruleset's required contexts in the same change.`,
      ),
  );
}

async function readWorkflows(): Promise<Map<string, Workflow>> {
  const workflows = new Map<string, Workflow>();
  for (const file of await readdir(workflowDirectory)) {
    if (!file.endsWith(".yml")) continue;
    const path = join(workflowDirectory, file);
    workflows.set(
      path,
      Bun.YAML.parse(await readFile(path, "utf8")) as Workflow,
    );
  }
  return workflows;
}

async function github(path: string): Promise<unknown> {
  const token = process.env["GITHUB_TOKEN"];
  const response = await fetch(
    `https://api.github.com/repos/${repository}${path}`,
    {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    },
  );
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  return response.json();
}

async function readRulesets(): Promise<Ruleset[]> {
  const listing = (await github("/rulesets")) as { id: number }[];
  return Promise.all(
    listing.map(async ({ id }) => {
      const ruleset = (await github(`/rulesets/${id}`)) as {
        name: string;
        rules: {
          type: string;
          parameters?: { required_status_checks?: { context: string }[] };
        }[];
      };
      const contexts = ruleset.rules.flatMap((rule) =>
        rule.type === "required_status_checks"
          ? (rule.parameters?.required_status_checks ?? []).map(
              (check) => check.context,
            )
          : [],
      );
      return { contexts, name: ruleset.name };
    }),
  );
}

if (import.meta.main) {
  const problems = unproducedChecks(
    await readRulesets(),
    await readWorkflows(),
  );
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
