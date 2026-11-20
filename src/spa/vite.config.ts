import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import { treePreloadPaths } from "./routes.ts";

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
