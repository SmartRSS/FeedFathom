import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { $ } from "bun";

const parentDir = path.resolve(__dirname, "..");
process.chdir(parentDir);

// Get update URL from command line arguments or use default for local development
const updateUrl =
  process.argv[2] ?? "https://feedfathom.com/assets/updates.json";

await $`bun install --frozen-lockfile`;
await $`sh -c '[ -d ext ] && rm -rf ext/build*/ || true'`;

// Build extension files
await $`bun build src/extension/background-event.ts --outfile=ext/build-ff/background-event.js`;
await $`bun build src/extension/content-script.ts --outfile=ext/build-ff/content-script.js`;
await $`bun build src/extension/options.ts --outfile=ext/build-ff/options.js`;

await $`cp src/lib/images/*-inverted-round.png ext/build-ff/`;
await $`cp src/extension/options.html ext/build-ff/options.html`;

// Read and process manifest for Firefox
const manifestFile = Bun.file("src/extension/manifest.json");
const baseManifestJsonString = await manifestFile.text();

// Replace the placeholder with the provided URL or default
const firefoxManifestString = baseManifestJsonString.replace(
  "%UPDATE_URL%",
  updateUrl,
);

await Bun.write("ext/build-ff/manifest.json", firefoxManifestString);

await $`cp -r ext/build-ff/ ext/build-ch/`;

const baseManifestData = JSON.parse(baseManifestJsonString);

baseManifestData.background.scripts = undefined;
baseManifestData.browser_specific_settings = undefined;

const chromiumManifestString = JSON.stringify(baseManifestData, null, 2);
await Bun.write("ext/build-ch/manifest.json", chromiumManifestString);

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

await createPackage("ext/build-ff/", "ext/FeedFathom_ff.zip");
await createPackage("ext/build-ch/", "ext/FeedFathom_ch.zip");

console.log("Extension built successfully!");
console.log("");
console.log("Files created:");
console.log("- ext/FeedFathom_ff.zip (Firefox)");
console.log("- ext/FeedFathom_ch.zip (Chromium)");
console.log("");
console.log("To install in Firefox:");
console.log("1. Open Firefox");
console.log("2. Go to about:debugging");
console.log("3. Click 'This Firefox'");
console.log("4. Click 'Load Temporary Add-on'");
console.log("5. Select ext/FeedFathom_ff.zip");
console.log("");
console.log("To install in Chrome/Edge:");
console.log("1. Open Chrome/Edge");
console.log("2. Go to chrome://extensions/");
console.log("3. Enable 'Developer mode'");
console.log("4. Click 'Load unpacked'");
console.log("5. Select ext/build-ch/ directory");
