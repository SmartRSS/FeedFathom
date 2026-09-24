import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

const spaDir = join(import.meta.dir, "..");
const entry = join(spaDir, "main.tsx");
const transpiler = new Bun.Transpiler({ loader: "tsx" });

// Every package and source file the SPA entry reaches statically. Either
// showing up here ships in the main chunk, parsed on every load; one reached
// only through import() lands in a chunk of its own.
async function spaGraph() {
  const packages = new Set<string>();
  const pending = [entry];
  const seen = new Set(pending);
  for (let file = pending.pop(); file; file = pending.pop()) {
    // eslint-disable-next-line no-await-in-loop -- A walk, one file at a time.
    const source = await Bun.file(file).text();
    for (const { kind, path } of transpiler.scanImports(source)) {
      // The transpiler injects its own JSX runtime as a require-call; the
      // SPA's real edges are ES imports.
      if (kind === "require-call" || kind === "dynamic-import") continue;
      const resolved = Bun.resolveSync(path, dirname(file));
      if (resolved.includes("/node_modules/")) packages.add(path);
      else if (!seen.has(resolved) && /\.tsx?$/u.test(resolved)) {
        seen.add(resolved);
        pending.push(resolved);
      }
    }
  }
  return { files: seen, packages };
}
const spaPackages = async () => (await spaGraph()).packages;

test("keeps the disposable-email domain list out of the SPA", async () => {
  const packages = await spaPackages();
  expect(packages.size).toBeGreaterThan(0);
  expect(packages).not.toContain("disposable-email-domains-js");
});

test("loads the Reader extraction libraries only on demand", async () => {
  const packages = await spaPackages();
  expect(packages).not.toContain("@extractus/article-extractor");
  expect(packages).not.toContain("@mozilla/readability");
  expect(packages).not.toContain("dompurify");
});

test("loads every route but the dashboard only on demand", async () => {
  const { files } = await spaGraph();
  expect(files).toContain(join(spaDir, "dashboard.tsx"));
  const dynamic = transpiler
    .scanImports(await Bun.file(entry).text())
    .filter(({ kind }) => kind === "dynamic-import")
    .map(({ path }) => path);
  for (const route of ["account-flows.tsx", "admin.tsx", "options.tsx"]) {
    expect(files).not.toContain(join(spaDir, route));
    expect(dynamic).toContain(`./${route}`);
  }
});
