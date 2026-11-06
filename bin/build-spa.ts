#!/usr/bin/env bun
// Builds the page with Vite and the service worker with Bun, then names the
// worker by a content hash of its bundle (see serviceWorkerFile).
import { $ } from "bun";
import { serviceWorkerFile } from "../src/spa/sw-protocol.ts";

const bundle = await Bun.build({
  entrypoints: ["src/spa/sw.ts"],
  format: "iife",
  minify: true,
  target: "browser",
});
const [output] = bundle.outputs;
if (!output) throw new Error("The service worker bundle is empty.");
const swSource = await output.text();
const hash = new Bun.CryptoHasher("sha256")
  .update(swSource)
  .digest("hex")
  .slice(0, 12);
const swFilename = serviceWorkerFile(hash);

await $`vite build --config src/spa/vite.config.ts`.env({
  ...process.env,
  VITE_SW_FILENAME: `/${swFilename}`,
});

await Bun.write(`build/spa/${swFilename}`, swSource);
