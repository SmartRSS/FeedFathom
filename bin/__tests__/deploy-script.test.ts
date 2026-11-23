import { expect, test } from "bun:test";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = await Bun.file("deploy/deploy.sh").text();
const removeMigration = /^remove_migration\(\) \{\n[\s\S]*?^\}$/m.exec(
  script,
)?.[0];

const fakeDocker = `#!/usr/bin/env bash
case "$1 $2" in
  "service rm") exit "$FAKE_RM_STATUS" ;;
  "service ls") printf '%s\\n' "$FAKE_SERVICES"; exit "$FAKE_LS_STATUS" ;;
esac
exit 64
`;

async function removeMigrationExit(docker: {
  rm: number;
  ls: number;
  services: string;
}): Promise<number> {
  if (removeMigration === undefined) throw new Error("no remove_migration()");
  const directory = await mkdtemp(join(tmpdir(), "deploy-script-"));
  await Bun.write(join(directory, "docker"), fakeDocker);
  await chmod(join(directory, "docker"), 0o755);
  const harness = [
    "set -Eeuo pipefail",
    removeMigration,
    "MIGRATION_SERVICE=feedfathom_migration",
    "MIGRATION_CREATED=true",
    "remove_migration",
  ].join("\n");
  const process_ = Bun.spawn(["bash", "-c", harness], {
    env: {
      FAKE_LS_STATUS: String(docker.ls),
      FAKE_RM_STATUS: String(docker.rm),
      FAKE_SERVICES: docker.services,
      PATH: `${directory}:${process.env["PATH"]}`,
    },
    stderr: "ignore",
    stdout: "ignore",
  });
  return process_.exited;
}

test("removing the migration job succeeds when docker removes it", async () => {
  expect(await removeMigrationExit({ ls: 0, rm: 0, services: "" })).toBe(0);
});

test("removing the migration job tolerates a job that is already gone", async () => {
  expect(
    await removeMigrationExit({ ls: 0, rm: 1, services: "feedfathom_server" }),
  ).toBe(0);
});

test("removing the migration job fails when the job is still there", async () => {
  expect(
    await removeMigrationExit({
      ls: 0,
      rm: 1,
      services: "feedfathom_migration\nfeedfathom_server",
    }),
  ).not.toBe(0);
});

test("removing the migration job fails when docker cannot list services", async () => {
  expect(await removeMigrationExit({ ls: 1, rm: 1, services: "" })).not.toBe(0);
});
