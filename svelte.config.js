import adapter from "svelte-adapter-bun";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const config = {
  preprocess: vitePreprocess(),
  optimizeDeps: { exclude: ["@sveltejs/kit"] },
  csrf: { checkOrigin: false },
  kit: {
    adapter: adapter({ precompress: false }),
  },
  vite: {
    svelte: {
      compilerOptions: {
        sourcemap: false,
      },
    },
  },
};

export default config;
