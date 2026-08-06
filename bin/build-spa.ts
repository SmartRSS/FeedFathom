#!/usr/bin/env bun
// Wraps `vite build` to give the service worker a content-hashed filename.
// Vite's public/ directory is copied byte-for-byte with no hashing (by
// design -- files needing a stable, predictable URL belong there), but the
// service worker specifically needs a URL that changes when its content
// does, so a CDN in front of production can't hand a client a stale copy.
import { $ } from "bun";

const swSource = await Bun.file("src/spa/public/sw.js").text();
const hash = new Bun.CryptoHasher("sha256")
  .update(swSource)
  .digest("hex")
  .slice(0, 12);
const swFilename = `sw-${hash}.js`;

await $`vite build --config src/spa/vite.config.ts`.env({
  ...process.env,
  VITE_SW_FILENAME: `/${swFilename}`,
});

await Bun.file("build/spa/sw.js").delete();
await Bun.write(`build/spa/${swFilename}`, swSource);
