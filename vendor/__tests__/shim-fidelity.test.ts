import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Two packages are replaced by a few lines in vendor/ rather than installed:
// `fast-xml-parser` (reimplemented on Bun.XML for @rowanmanning/feed-parser)
// and `linkedom` (the browser's own DOMParser, for
// @extractus/article-extractor). Both replacements are partial by design --
// they implement what their one dependent actually uses and nothing else.
//
// That makes a dependency bump the risk. If a new version of the dependent
// reaches for an API the shim never implemented, or if the resolution trick
// stops working and the real package lands nested under the dependent, the
// only symptom is at runtime: a crash on a feed nobody tested, or 189 KB of
// pure-JS DOM silently back in the SPA bundle. This is that bump's alarm.
const shims = [
  {
    dependent: "@rowanmanning/feed-parser",
    package: "fast-xml-parser",
    shimDirectory: "fast-xml-parser-shim",
  },
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

// Both spellings the dependents use: a destructured import or require, and a
// whole-module require whose properties are read later.
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
    // The real packages are 2.6 MB and 900 KB of source; a nested copy is how
    // the override silently stops applying.
    const nested = await readdir(
      join(modules, shim.dependent, "node_modules"),
    ).catch(() => [] as string[]);
    expect(nested).not.toContain(shim.package);

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
    // A dependent that imports nothing at all means the regexes stopped
    // matching, not that the shim got easier.
    expect(wanted.size).toBeGreaterThan(0);

    const exported: object = await import(shim.package);
    expect([...wanted].toSorted()).toEqual(
      [...wanted].filter((name) => name in exported).toSorted(),
    );
  });
});
