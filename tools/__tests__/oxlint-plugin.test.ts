import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pluginPath = resolve(import.meta.dir, "../oxlint-plugin.js");
const oxlintBin = resolve(import.meta.dir, "../../node_modules/.bin/oxlint");
let directory = "";

const config = {
  jsPlugins: [pluginPath],
  rules: {
    "feedfathom/layer-boundaries": [
      "error",
      { features: { auth: [], feeds: ["auth"], reader: ["auth", "feeds"] } },
    ],
    "feedfathom/no-barrel-file": [
      "error",
      { allow: ["src/platform/db/schema.ts"] },
    ],
    "feedfathom/schema-compile-module-scope": "error",
  },
} as const;

function diagnosticCodes(stdout: string, stderr: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `oxlint did not emit JSON.\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  if (!("diagnostics" in parsed)) return [];
  const { diagnostics } = parsed;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    if (!("code" in entry)) return [];
    return typeof entry.code === "string" ? [entry.code] : [];
  });
}

async function lintFile(relativePath: string): Promise<string[]> {
  const child = Bun.spawn({
    cmd: [
      oxlintBin,
      "-c",
      join(directory, ".oxlintrc.json"),
      "--format",
      "json",
      relativePath,
    ],
    cwd: directory,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect([0, 1]).toContain(exitCode);
  return diagnosticCodes(stdout, stderr).filter((name) =>
    name.includes("feedfathom"),
  );
}

async function lint(name: string, code: string): Promise<string[]> {
  await writeFile(join(directory, name), code);
  return lintFile(name);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ff-oxlint-"));
  await writeFile(
    join(directory, ".oxlintrc.json"),
    JSON.stringify(config, null, 2),
  );
});

afterAll(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
}, 20_000);

test("schema-compile-module-scope flags compiles inside functions", async () => {
  expect(
    await lint("a.ts", "function f() { return Schema.Compile(s); }"),
  ).toHaveLength(1);
  expect(await lint("b.ts", "const f = () => Schema.Compile(s);")).toHaveLength(
    1,
  );
}, 20_000);

test("schema-compile-module-scope allows module scope", async () => {
  expect(await lint("c.ts", "const check = Schema.Compile(schema);")).toEqual(
    [],
  );
  expect(
    await lint("d.ts", "function f() {}\nconst check = Schema.Compile(s);"),
  ).toEqual([]);
  expect(
    await lint("e.ts", "function f() { return Other.Compile(s); }"),
  ).toEqual([]);
}, 20_000);

test("no-barrel-file flags re-export-only modules", async () => {
  expect(
    await lint(
      "l.ts",
      'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nexport { a, b };',
    ),
  ).toHaveLength(1);
  expect(await lint("m.ts", 'export * from "./a.ts";')).toHaveLength(1);
  expect(await lint("n.ts", 'export { a } from "./a.ts";')).toHaveLength(1);
}, 20_000);

test("no-barrel-file allows own exports and local bindings", async () => {
  expect(
    await lint(
      "o.ts",
      'import { a } from "./a.ts";\nexport const b = 1;\nexport { a };',
    ),
  ).toEqual([]);
  expect(await lint("p.ts", "const theme = 1;\nexport { theme };")).toEqual([]);
}, 20_000);

test("no-barrel-file honours the allow list", async () => {
  expect(
    await lint("schema.ts", 'import { a } from "./a.ts";\nexport { a };'),
  ).toHaveLength(1);
  const file = join("src", "platform", "db", "schema.ts");
  await Bun.write(
    join(directory, file),
    'import { a } from "../../../a.ts";\nexport { a };',
  );
  expect(await lintFile(file)).toEqual([]);
}, 20_000);

async function lintAt(path: string, code: string): Promise<string[]> {
  await Bun.write(join(directory, path), code);
  return lintFile(path);
}

test("layer-boundaries allows downward and declared imports", async () => {
  expect(
    await lintAt(
      join("src", "features", "reader", "down.ts"),
      'import { a } from "#platform/db/connection.ts";\nimport { b } from "#shared/util/safe-url.ts";\nexport const c = a + b;',
    ),
  ).toEqual([]);
  expect(
    await lintAt(
      join("src", "features", "reader", "declared.ts"),
      'import { a } from "#features/feeds/feed-parser.ts";\nimport { b } from "#features/reader/own.ts";\nexport const c = a + b;',
    ),
  ).toEqual([]);
  expect(
    await lintAt(
      join("src", "root.ts"),
      'import { a } from "#features/reader/routes.ts";\nexport const b = a;',
    ),
  ).toEqual([]);
}, 20_000);

test("layer-boundaries rejects upward imports", async () => {
  expect(
    await lintAt(
      join("src", "shared", "up.ts"),
      'import { a } from "#platform/config.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
  expect(
    await lintAt(
      join("src", "platform", "up.ts"),
      'import { a } from "#features/feeds/feed-parser.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
}, 20_000);

test("layer-boundaries rejects an undeclared feature edge", async () => {
  expect(
    await lintAt(
      join("src", "features", "auth", "sideways.ts"),
      'import { a } from "#features/feeds/feed-parser.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
}, 20_000);

test("layer-boundaries rejects a client importing a feature", async () => {
  expect(
    await lintAt(
      join("src", "spa", "reach.ts"),
      'import { a } from "#features/feeds/feed-mapper.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
  expect(
    await lintAt(
      join("src", "spa", "cross.ts"),
      'import { a } from "../extension/extension-types.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
}, 20_000);

test("layer-boundaries judges relative specifiers by the same rule", async () => {
  expect(
    await lintAt(
      join("src", "shared", "util", "sneak.ts"),
      'import { a } from "../../platform/config.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
  expect(
    await lintAt(
      join("src", "shared", "util", "sibling.ts"),
      'import { a } from "./safe-url.ts";\nexport const b = a;',
    ),
  ).toEqual([]);
}, 20_000);

test("layer-boundaries checks dynamic imports too", async () => {
  expect(
    await lintAt(
      join("src", "features", "auth", "lazy.ts"),
      'export const a = async () => import("#features/feeds/feed-parser.ts");',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
  expect(
    await lintAt(
      join("src", "features", "auth", "lazy-ok.ts"),
      'export const a = async () => import("#shared/util/safe-url.ts");',
    ),
  ).toEqual([]);
}, 20_000);

test("layer-boundaries exempts co-located tests", async () => {
  expect(
    await lintAt(
      join("src", "shared", "util", "arrange.test.ts"),
      'import { a } from "#features/feeds/feed-parser.ts";\nexport const b = a;',
    ),
  ).toEqual([]);
}, 20_000);
