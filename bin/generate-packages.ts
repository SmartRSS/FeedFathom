#!/usr/bin/env bun

import { $ } from "bun";
import fs from "fs";
import archiver from "archiver";
import path from "path";

const parentDir = path.resolve(__dirname, "..");
process.chdir(parentDir);

await $`bun i --frozen-lockfile`;
await $`sh -c '[ -d ext ] && rm -rf ext/build*/ || true'`;
await $`bun build src/bg.ts --outfile=ext/build-ff/bg.js`;
await $`bun build src/contentscript.ts --outfile=ext/build-ff/contentscript.js`;
await $`bun build src/options.ts --outfile=ext/build-ff/options.js`;
await $`cp src/lib/images/*-inverted-round.png ext/build-ff/`;
await $`cp src/options.html ext/build-ff/options.html`;
await $`cp src/we-manifest.json ext/build-ff/manifest.json`;

async function createPackage(from: string, target: string) {
  const output = fs.createWriteStream(target);
  const archive = archiver("zip", {
    zlib: { level: 9 },
  });
  archive.on("error", function (err: unknown) {
    throw err;
  });
  archive.pipe(output);
  archive.directory(from, false);
  await archive.finalize();
}

await $`cp -r ext/build-ff/ ext/build-ch/`;

const baseManifestJsonString = await fs.promises.readFile(
  "src/we-manifest.json",
  "utf-8",
);
const baseManifestData = JSON.parse(baseManifestJsonString);

delete baseManifestData.background.scripts;
delete baseManifestData.browser_specific_settings;

const chromiumManifestString = JSON.stringify(baseManifestData, null, 2);
await fs.promises.writeFile(
  "ext/build-ch/manifest.json",
  chromiumManifestString,
  "utf-8",
);
await $`sed -i 's/browser./chrome./g' ext/build-ch/*.js`;

await createPackage("ext/build-ff/", "ext/FeedFathom_ff.zip");
await createPackage("ext/build-ch/", "ext/FeedFathom_ch.zip");
