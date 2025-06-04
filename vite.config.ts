import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      external: ["jsdom"],
      onwarn(warning, warn) {
        if (
          warning.code === "EVAL" &&
          warning.id?.includes("fast-xml-parser")
        ) {
          return;
        }

        warn(warning);
      },
    },
    target: "esnext",
  },
  optimizeDeps: {
    exclude: ["@sveltejs/kit", "jsdom"],
  },
  plugins: [sveltekit()],
  experimental: {
    enableNativePlugin: true,
  },
  ssr: {
    external: ["jsdom"],
    noExternal: ["@mozilla/readability", "dompurify"],
  },
});
