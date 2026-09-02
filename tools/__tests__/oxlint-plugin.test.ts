import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// oxlint's own `RuleTester` needs raw-transfer support, which Bun does not
// provide, so these run the real linter against fixtures written to a temp
// directory instead. That also exercises plugin loading end to end, and keeps
// the deliberately-broken fixtures out of the repo's own lint run.

const pluginPath = resolve(import.meta.dir, "../oxlint-plugin.js");
// Resolved absolutely rather than via `bunx`: these run with `cwd` set to a
// temp directory, where `bunx` cannot see the project's node_modules and would
// try to fetch its own copy of oxlint instead.
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
    "feedfathom/route-deps-narrowed": "error",
    "feedfathom/schema-compile-module-scope": "error",
  },
} as const;

/** Pull the diagnostic codes out of oxlint's JSON report without asserting. */
function diagnosticCodes(stdout: string, stderr: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // oxlint failing to start prints a plain-text reason. Surface that rather
    // than a bare "Unexpected identifier" from the JSON parser.
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

/** Lint an already-written file, returning only this plugin's rule names. */
function lintFile(relativePath: string): string[] {
  const result = Bun.spawnSync({
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
  return diagnosticCodes(
    result.stdout.toString(),
    result.stderr.toString(),
  ).filter((name) => name.includes("feedfathom"));
}

/** Lint one source string and return the rule names that fired. */
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
});

test("schema-compile-module-scope flags compiles inside functions", async () => {
  expect(
    await lint("a.ts", "function f() { return Schema.Compile(s); }"),
  ).toHaveLength(1);
  expect(await lint("b.ts", "const f = () => Schema.Compile(s);")).toHaveLength(
    1,
  );
});

test("schema-compile-module-scope allows module scope", async () => {
  expect(await lint("c.ts", "const check = Schema.Compile(schema);")).toEqual(
    [],
  );
  // Function depth must reset after a function closes, not leak onward.
  expect(
    await lint("d.ts", "function f() {}\nconst check = Schema.Compile(s);"),
  ).toEqual([]);
  expect(
    await lint("e.ts", "function f() { return Other.Compile(s); }"),
  ).toEqual([]);
});

test("route-deps-narrowed flags a whole service type", async () => {
  expect(
    await lint(
      "f.ts",
      "export type TreeRouteDependencies = { usersDataService: UsersDataService };",
    ),
  ).toHaveLength(1);
});

test("route-deps-narrowed allows narrowed and non-service fields", async () => {
  expect(
    await lint(
      "g.ts",
      'export type TreeRouteDependencies = { usersDataService: Pick<UsersDataService, "getUserBySid"> };',
    ),
  ).toEqual([]);
  expect(
    await lint(
      "h.ts",
      "export type TreeRouteDependencies = { httpClient: { get(url: string): Promise<string> } };",
    ),
  ).toEqual([]);
  expect(
    await lint("i.ts", "export type Other = { svc: UsersDataService };"),
  ).toEqual([]);
});

test("no-barrel-file flags re-export-only modules", async () => {
  expect(
    await lint(
      "l.ts",
      'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nexport { a, b };',
    ),
  ).toHaveLength(1);
  expect(await lint("m.ts", 'export * from "./a.ts";')).toHaveLength(1);
  expect(await lint("n.ts", 'export { a } from "./a.ts";')).toHaveLength(1);
});

test("no-barrel-file allows own exports and local bindings", async () => {
  expect(
    await lint(
      "o.ts",
      'import { a } from "./a.ts";\nexport const b = 1;\nexport { a };',
    ),
  ).toEqual([]);
  expect(await lint("p.ts", "const theme = 1;\nexport { theme };")).toEqual([]);
});

test("no-barrel-file honours the allow list", async () => {
  // Same shape as the flagged barrel, but at the exempted path.
  expect(
    await lint("schema.ts", 'import { a } from "./a.ts";\nexport { a };'),
  ).toHaveLength(1);
  // Identical shape at the exempted path is allowed.
  const file = join("src", "platform", "db", "schema.ts");
  await Bun.write(
    join(directory, file),
    'import { a } from "../../../a.ts";\nexport { a };',
  );
  expect(lintFile(file)).toEqual([]);
});

/** Write a fixture at a path the layer rule reads, and lint it there. */
async function lintAt(path: string, code: string): Promise<string[]> {
  await Bun.write(join(directory, path), code);
  return lintFile(path);
}

test("layer-boundaries allows downward and declared imports", async () => {
  // Feature -> platform and feature -> shared are downward.
  expect(
    await lintAt(
      join("src", "features", "reader", "down.ts"),
      'import { a } from "#platform/db/connection.ts";\nimport { b } from "#shared/util/safe-url.ts";\nexport const c = a + b;',
    ),
  ).toEqual([]);
  // reader -> feeds is on the declared list, and a feature may always import
  // itself.
  expect(
    await lintAt(
      join("src", "features", "reader", "declared.ts"),
      'import { a } from "#features/feeds/feed-parser.ts";\nimport { b } from "#features/reader/own.ts";\nexport const c = a + b;',
    ),
  ).toEqual([]);
  // The composition root may import anything.
  expect(
    await lintAt(
      join("src", "root.ts"),
      'import { a } from "#features/reader/routes.ts";\nexport const b = a;',
    ),
  ).toEqual([]);
});

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
});

test("layer-boundaries rejects an undeclared feature edge", async () => {
  // feeds -> auth is declared; auth -> feeds is not.
  expect(
    await lintAt(
      join("src", "features", "auth", "sideways.ts"),
      'import { a } from "#features/feeds/feed-parser.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
});

test("layer-boundaries rejects a client importing a feature", async () => {
  expect(
    await lintAt(
      join("src", "spa", "reach.ts"),
      'import { a } from "#features/feeds/feed-mapper.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
  // ... and one client reaching into the other.
  expect(
    await lintAt(
      join("src", "spa", "cross.ts"),
      'import { a } from "../extension/extension-types.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
});

test("layer-boundaries judges relative specifiers by the same rule", async () => {
  // `../../` must not be an escape hatch from what `#platform/` enforces.
  expect(
    await lintAt(
      join("src", "shared", "util", "sneak.ts"),
      'import { a } from "../../platform/config.ts";\nexport const b = a;',
    ),
  ).toEqual(["feedfathom(layer-boundaries)"]);
  // A relative import that stays inside the layer is fine.
  expect(
    await lintAt(
      join("src", "shared", "util", "sibling.ts"),
      'import { a } from "./safe-url.ts";\nexport const b = a;',
    ),
  ).toEqual([]);
});

test("layer-boundaries checks dynamic imports too", async () => {
  // One `await import()` would otherwise be enough to walk around the rule.
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
});

test("layer-boundaries exempts co-located tests", async () => {
  expect(
    await lintAt(
      join("src", "shared", "util", "arrange.test.ts"),
      'import { a } from "#features/feeds/feed-parser.ts";\nexport const b = a;',
    ),
  ).toEqual([]);
});
