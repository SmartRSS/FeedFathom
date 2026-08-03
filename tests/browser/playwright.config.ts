import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "../..");

const externalBaseUrl = process.env["PLAYWRIGHT_BASE_URL"];
const localPort = process.env["PLAYWRIGHT_PORT"] ?? "3456";
const localBaseUrl = `http://127.0.0.1:${localPort}`;

export default defineConfig({
  testDir: path.join(root, "tests/browser"),
  outputDir: path.join(root, "test-results"),
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: externalBaseUrl ?? localBaseUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: `bun run watch-spa -- --port ${localPort}`,
          cwd: root,
          reuseExistingServer: true,
          url: localBaseUrl,
        },
      }),
});
