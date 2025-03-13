import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import adapter from "svelte-adapter-bun";

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
    build: {
      target: "esnext",
      minify: "terser",
      terserOptions: {
        compress: {
          drop_console: true,
          drop_debugger: true,
        },
      },
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ["svelte", "@sveltejs/kit"],
          },
        },
      },
    },
    optimizeDeps: {
      include: ["svelte", "@sveltejs/kit"],
    },
  },
};

export default config;
