import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { $ } from "bun";

const parentDir = path.resolve(__dirname, "..");
process.chdir(parentDir);

await $`bun install --frozen-lockfile`;
await $`sh -c '[ -d ext ] && rm -rf ext/build*/ || true'`;
await $`bun build src/extension/background-event.ts --outfile=ext/build-ff/background-event.js`;
await $`bun build src/extension/content-script.ts --outfile=ext/build-ff/content-script.js`;
await $`bun build src/extension/options.ts --outfile=ext/build-ff/options.js`;
await $`cp src/lib/images/*-inverted-round.png ext/build-ff/`;
await $`cp src/extension/options.html ext/build-ff/options.html`;
await $`cp src/extension/manifest.json ext/build-ff/manifest.json`;

async function createPackage(from: string, target: string) {
  const output = fs.createWriteStream(target);
  const archive = archiver("zip", {
    zlib: { level: 9 },
  });
  archive.on("error", (err: unknown) => {
    throw err;
  });
  archive.pipe(output);
  archive.directory(from, false);
  await archive.finalize();
}

await $`cp -r ext/build-ff/ ext/build-ch/`;

const manifestFile = Bun.file("src/extension/manifest.json");
const baseManifestJsonString = await manifestFile.text();

const baseManifestData = JSON.parse(baseManifestJsonString);

baseManifestData.background.scripts = undefined;
baseManifestData.browser_specific_settings = undefined;

const chromiumManifestString = JSON.stringify(baseManifestData, null, 2);
await Bun.write("ext/build-ch/manifest.json", chromiumManifestString);

await createPackage("ext/build-ff/", "ext/FeedFathom_ff.zip");
await createPackage("ext/build-ch/", "ext/FeedFathom_ch.zip");
