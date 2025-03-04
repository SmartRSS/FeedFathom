import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    include: ["@mozilla/readability", "jsdom", "dompurify"],
  },
  plugins: [
    sveltekit(),
  ]
});
