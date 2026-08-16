import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// oxlint's own `RuleTester` needs raw-transfer support, which Bun does not
// provide, so these run the real linter against fixtures written to a temp
// directory instead. That also exercises plugin loading end to end, and keeps
// the deliberately-broken fixtures out of the repo's own lint run.

const pluginPath = resolve(import.meta.dir, "../tools/oxlint-plugin.ts");
let directory = "";

const config = {
  jsPlugins: [pluginPath],
  rules: {
    "feedfathom/import-grouping": "error",
    "feedfathom/no-barrel-file": ["error", { allow: ["src/db/schema.ts"] }],
    "feedfathom/route-deps-narrowed": "error",
    "feedfathom/schema-compile-module-scope": "error",
  },
} as const;

/** Pull the diagnostic codes out of oxlint's JSON report without asserting. */
function diagnosticCodes(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
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
      "bunx",
      "oxlint",
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
  return diagnosticCodes(result.stdout.toString()).filter((name) =>
    name.includes("feedfathom"),
  );
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

test("import-grouping flags a package import after a relative one", async () => {
  expect(
    await lint(
      "j.ts",
      'import { a } from "./a.ts";\nimport { b } from "node:fs";\nexport const c = [a, b];',
    ),
  ).toHaveLength(1);
});

test("import-grouping allows packages first", async () => {
  expect(
    await lint(
      "k.ts",
      'import { a } from "node:fs";\nimport { b } from "./b.ts";\nexport const c = [a, b];',
    ),
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
  const file = join("src", "db", "schema.ts");
  await Bun.write(
    join(directory, file),
    'import { a } from "../../a.ts";\nexport { a };',
  );
  expect(lintFile(file)).toEqual([]);
});
