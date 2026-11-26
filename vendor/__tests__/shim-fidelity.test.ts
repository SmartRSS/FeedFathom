import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const shims = [
  {
    dependent: "@extractus/article-extractor",
    package: "linkedom",
    shimDirectory: "linkedom-shim",
  },
];

const modules = fileURLToPath(new URL("../../node_modules", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true });
  return entries
    .filter((entry) => /\.(?:c|m)?js$/.test(entry))
    .map((entry) => join(directory, entry));
}

function importedNames(source: string, packageName: string): Set<string> {
  const names = new Set<string>();
  const specifier = String.raw`['"]${packageName}['"]`;
  const destructured = new RegExp(
    String.raw`(?:import\s*\{([^}]*)\}\s*from\s*${specifier}|\{([^}]*)\}\s*=\s*require\(\s*${specifier}\s*\))`,
    "g",
  );
  for (const match of source.matchAll(destructured)) {
    for (const binding of (match[1] ?? match[2] ?? "").split(",")) {
      const name = binding.split(/\s+as\s+/)[0]?.trim();
      if (name) names.add(name);
    }
  }

  const namespace = new RegExp(
    String.raw`(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*${specifier}\s*\)`,
    "g",
  );
  for (const match of source.matchAll(namespace)) {
    for (const use of source.matchAll(
      new RegExp(String.raw`\b${match[1]!}\.(\w+)`, "g"),
    )) {
      names.add(use[1]!);
    }
  }
  return names;
}

describe.each(shims)("$package shim", (shim) => {
  test("is what the dependent resolves, not a nested real package", async () => {
    const resolved = Bun.resolveSync(
      shim.package,
      join(modules, shim.dependent),
    );
    const shimEntry = Bun.resolveSync(
      `../${shim.shimDirectory}`,
      import.meta.dir,
    );
    expect(await Bun.file(resolved).text()).toBe(
      await Bun.file(shimEntry).text(),
    );

    const installed: unknown = await Bun.file(
      join(modules, shim.package, "package.json"),
    ).json();
    const vendored: unknown = await Bun.file(
      fileURLToPath(
        new URL(`../${shim.shimDirectory}/package.json`, import.meta.url),
      ),
    ).json();
    expect(installed).toEqual(vendored);
  });

  test("exports everything the dependent imports from it", async () => {
    const files = await sourceFiles(join(modules, shim.dependent));
    const wanted = new Set<string>();
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop -- one dependent's sources.
      const source = await readFile(file, "utf8");
      for (const name of importedNames(source, shim.package)) wanted.add(name);
    }
    expect(wanted.size).toBeGreaterThan(0);

    const exported: object = await import(shim.package);
    expect([...wanted].toSorted()).toEqual(
      [...wanted].filter((name) => name in exported).toSorted(),
    );
  });
});
