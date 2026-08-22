import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const compose = async (...arguments_: string[]): Promise<number> =>
  await Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      "compose.yml",
      "-f",
      "deploy/compose.dev.yml",
      ...arguments_,
    ],
    {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  ).exited;

const down = () => compose("down", "--remove-orphans");

if (process.argv[2] === "--down") {
  process.exit(await down());
}
if (process.argv.length > 2) {
  throw new Error(`Unknown development option: ${process.argv[2]}`);
}

// Starting and waiting are two calls because `up --wait` reports the
// migrator's clean exit(0) as a failure, and naming services does not help
// -- a named service's dependencies are waited on too. So: start everything,
// then wait only on the two that stay up. Nothing is lost, because the
// worker blocks until the schema exists, which means waiting for the worker
// to report healthy already waits for migrations to have succeeded.
const startup =
  (await compose("up", "-d", "--build")) ||
  (await compose(
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "300",
    "server",
    "worker",
  ));
if (startup !== 0) process.exit(startup);

const vite = Bun.spawn([process.execPath, "run", "watch-spa"], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
let stopping: Promise<number> | undefined;
const stop = (signal?: NodeJS.Signals): Promise<number> => {
  stopping ??= (async () => {
    if (signal) vite.kill(signal);
    const viteExit = await vite.exited;
    const downExit = await down();
    return viteExit || downExit;
  })();
  return stopping;
};

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

await vite.exited;
process.exit(await stop());
