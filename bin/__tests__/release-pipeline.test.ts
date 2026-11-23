import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Step = { name?: string; run?: string };
type Job = {
  env?: Record<string, string>;
  needs?: string | string[];
  steps?: Step[];
};
type Workflow = { env?: Record<string, string>; jobs: Record<string, Job> };

const workflow = Bun.YAML.parse(
  await Bun.file(".github/workflows/docker-build.yml").text(),
) as Workflow;

function needsOf(id: string): string[] {
  const needs = workflow.jobs[id]?.needs;
  if (needs === undefined) return [];
  return typeof needs === "string" ? [needs] : [...needs];
}

function ancestors(id: string, stopAt?: string): Set<string> {
  const found = new Set<string>();
  const pending = needsOf(id);
  while (pending.length > 0) {
    const need = pending.pop();
    if (need === undefined || need === stopAt || found.has(need)) continue;
    found.add(need);
    pending.push(...needsOf(need));
  }
  return found;
}

function stepScript(jobId: string, stepName: string): string {
  const step = workflow.jobs[jobId]?.steps?.find((s) => s.name === stepName);
  if (step?.run === undefined) throw new Error(`no run step "${stepName}"`);
  return step.run;
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "release-pipeline-"));
}

async function executable(path: string, body: string): Promise<void> {
  await Bun.write(path, body);
  await chmod(path, 0o755);
}

async function runStep(
  script: string,
  options: { cwd: string; bin: string; env: Record<string, string> },
) {
  const scriptPath = join(options.cwd, "step.sh");
  await Bun.write(scriptPath, script);
  const process_ = Bun.spawn(["bash", "-e", scriptPath], {
    cwd: options.cwd,
    env: {
      ...options.env,
      PATH: `${options.bin}:${dirname(process.execPath)}:${process.env["PATH"]}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function versionAt(instant: string): Promise<number[]> {
  const directory = await scratch();
  const bin = join(directory, "bin");
  await mkdir(bin);
  const realDate = Bun.which("date");
  if (realDate === null) throw new Error("date is not on PATH");
  await executable(
    join(bin, "date"),
    `#!/bin/sh\nexec ${realDate} -d "$FAKE_NOW" "$@"\n`,
  );
  const output = join(directory, "output");
  const result = await runStep(
    stepScript("build_metadata", "Compute version"),
    {
      bin,
      cwd: directory,
      env: { FAKE_NOW: instant, GITHUB_OUTPUT: output },
    },
  );
  expect(result.stderr).toBe("");
  const line = await readFile(output, "utf8");
  return line.trim().replace("version=", "").split(".").map(Number);
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

test("the release version keeps rising across the turn of a century", async () => {
  const before = await versionAt("2099-12-31T23:59:59Z");
  const after = await versionAt("2100-01-01T00:00:00Z");
  expect(compareVersions(after, before)).toBeGreaterThan(0);
});

test("a release version from now sorts above every version the two-digit year issued", async () => {
  const now = await versionAt("2026-11-23T00:00:00Z");
  expect(compareVersions(now, [26, 466, 2439, 70])).toBeGreaterThan(0);
});

test("a manual deploy reaches deploy only through await_turn", () => {
  expect(ancestors("deploy")).toContain("release_smoke_dispatch");
  expect(ancestors("deploy")).toContain("release_smoke_push");
  const bypassing = ancestors("deploy", "await_turn");
  expect(bypassing).not.toContain("release_smoke_dispatch");
  expect(bypassing).not.toContain("release_smoke_push");
});

const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
command=$1
shift
if [[ "$command" == api ]]; then
  paginate=false slurp=false filter=""
  while (($#)); do
    case "$1" in
      --paginate) paginate=true ;;
      --slurp) slurp=true ;;
      --jq) filter=$2; shift ;;
    esac
    shift
  done
  if [[ "$slurp" == true ]]; then
    [[ "$paginate" == true && -z "$filter" ]]
    jq -s . "$FAKE_GH"/page-*.json
  elif [[ "$paginate" == true ]]; then
    for page in "$FAKE_GH"/page-*.json; do jq -r "$filter" "$page"; done
  else
    jq -r "\${filter:-.}" "$FAKE_GH"/page-1.json
  fi
elif [[ "$command $1" == "release download" ]]; then
  printf '%s\\n' "$2" >> "$FAKE_GH/downloads"
  while [[ "$1" != --output ]]; do shift; done
  if [[ "$2" == - ]]; then printf 'previous-hash'; else printf 'asset' > "$2"; fi
elif [[ "$command $1" == "release view" ]]; then
  printf '2026-10-01T12:00:00Z\\n'
else
  exit 64
fi
`;

const newestPage = Array.from({ length: 100 }, (_, index) => ({
  assets: [{ name: "notes.txt" }],
  draft: false,
  prerelease: index % 2 === 0,
  tag_name: `release-${index}`,
}));

const olderPage = [
  {
    assets: [{ name: "extension-content-hash.txt" }],
    draft: false,
    prerelease: true,
    tag_name: "staging-with-hash",
  },
  {
    assets: [{ name: "feedfathom-firefox-1.xpi" }],
    draft: false,
    prerelease: false,
    tag_name: "v-with-xpi",
  },
];

async function releaseFixture() {
  const directory = await scratch();
  const bin = join(directory, "bin");
  const gh = join(directory, "gh");
  await mkdir(bin);
  await mkdir(gh);
  await executable(join(bin, "gh"), fakeGh);
  await executable(
    join(bin, "unzip"),
    `#!/bin/sh\nprintf '{"version":"126.1.1.1"}'\n`,
  );
  await Bun.write(join(gh, "page-1.json"), JSON.stringify(newestPage));
  await Bun.write(join(gh, "page-2.json"), JSON.stringify(olderPage));
  const env = {
    FAKE_GH: gh,
    GITHUB_ENV: join(directory, "env"),
    GITHUB_OUTPUT: join(directory, "output"),
    GITHUB_REPOSITORY: "owner/repo",
  };
  return { bin, cwd: directory, env };
}

test("the content-hash lookup finds a previous release past the first page", async () => {
  const fixture = await releaseFixture();
  await Bun.write(join(fixture.cwd, "ext/build-ch/main.js"), "chromium");
  await Bun.write(join(fixture.cwd, "ext/build-ff/main.js"), "firefox");
  const result = await runStep(
    stepScript(
      "build_extension",
      "Detect whether the extension actually changed",
    ),
    { ...fixture, env: { ...fixture.env, GITHUB_REF: "refs/heads/staging" } },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Comparing against staging-with-hash");
});

test("the docs deploy republishes an extension from past the first page", async () => {
  const fixture = await releaseFixture();
  const result = await runStep(
    stepScript("pages", "Publish extension files to docs"),
    { ...fixture, env: { ...fixture.env, BUILD_DATE: "" } },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Republishing the extension from v-with-xpi");
});

test("the deploy job hands production its port as FEEDFATHOM_PORT", async () => {
  const deploy = workflow.jobs["deploy"];
  expect(deploy?.env?.["FEEDFATHOM_PORT"]).toBe("${{ vars.FEEDFATHOM_PORT }}");
  const list = /variables=\(([^)]*)\)/.exec(
    stepScript("deploy", "Generate protected deployment environment"),
  );
  const names = list?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  expect(names).toContain("FEEDFATHOM_PORT");
  const defined = { ...workflow.env, ...deploy?.env };
  expect(names.filter((name) => !(name in defined))).toEqual([]);
  const script = await Bun.file("deploy/deploy.sh").text();
  expect(script).not.toContain("SERVER_HOST_PORT");
});
