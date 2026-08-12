import solid from "vite-plugin-solid";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/spa",
  cacheDir: "../../.cache/vite",
  plugins: [solid()],
  build: { outDir: "../../build/spa", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 3456,
    strictPort: true,
    proxy: { "^/api/": "http://127.0.0.1:3001" },
  },
});
