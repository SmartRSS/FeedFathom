import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "../..");

const externalBaseUrl = process.env["PLAYWRIGHT_BASE_URL"];
const browserChannel = process.env["PLAYWRIGHT_CHANNEL"];
const localPort = process.env["PLAYWRIGHT_PORT"] ?? "3456";
const localBaseUrl = `http://127.0.0.1:${localPort}`;

export default defineConfig({
  fullyParallel: true,
  outputDir: path.join(root, "test-results"),
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
  reporter: "list",
  testDir: path.join(root, "tests/browser"),
  testIgnore: externalBaseUrl ? [] : ["**/production-smoke.spec.ts"],
  use: {
    baseURL: externalBaseUrl ?? localBaseUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  ...(process.env["CI"] ? { workers: 4 } : {}),
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: `bun run watch-spa -- --port ${localPort}`,
          cwd: root,
          reuseExistingServer: false,
          url: localBaseUrl,
        },
      }),
});
