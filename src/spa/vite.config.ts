import solid from "vite-plugin-solid";
import { defineConfig } from "vite";
import { treePreloadPaths } from "./routes.ts";

// Both default to what a single checkout has always used. They exist so a
// second one -- a git worktree, a review checkout -- can run its own stack
// beside the first instead of fighting it for two fixed ports. See
// docs/contributing.md.
const apiPort = process.env["FEEDFATHOM_DEV_API_PORT"] ?? "3001";
const spaPort = Number(process.env["FEEDFATHOM_DEV_SPA_PORT"] ?? "3456");

export default defineConfig({
  root: "src/spa",
  cacheDir: "../../.cache/vite",
  plugins: [
    solid(),
    {
      name: "tree-preload-paths",
      transformIndexHtml: (html) =>
        html.replace(
          "TREE_PRELOAD_PATHS",
          treePreloadPaths.source,
        ),
    },
  ],
  build: { outDir: "../../build/spa", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: spaPort,
    strictPort: true,
    proxy: { "^/api/": `http://127.0.0.1:${apiPort}` },
  },
});
