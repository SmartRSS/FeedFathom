import adapter from "svelte-adapter-bun";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const config = {
  preprocess: vitePreprocess(),
  optimizeDeps: { exclude: ["@sveltejs/kit"] },
  csrf: { checkOrigin: false },
  kit: {
    adapter: adapter({ precompress: true }),
  },
  vite: {
    svelte: {
      compilerOptions: {
        sourcemap: true,
      },
    },
  },
};

export default config;
