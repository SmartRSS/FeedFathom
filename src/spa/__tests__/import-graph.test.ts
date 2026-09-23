import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

// Every package the SPA entry reaches statically through its own source
// files. A package showing up here ships in the main chunk, parsed on every
// load; one reached only through import() lands in a chunk of its own.
async function spaPackages() {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const packages = new Set<string>();
  const pending = [join(import.meta.dir, "..", "main.tsx")];
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
  return packages;
}

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
