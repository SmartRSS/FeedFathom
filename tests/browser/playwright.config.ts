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
  // fullyParallel: false only serializes tests *within* a file -- with
  // more than one spec file, Playwright can still assign different files
  // to different parallel workers, all sharing this config's single Vite
  // dev server. Under CI's much smaller CPU budget than a real dev
  // machine, two real Chromium instances plus concurrent Vite module
  // compilation contending for the same couple of vCPUs can genuinely
  // stall a heavy real-app page load past any timeout (a persistent-
  // context + real-extension test hung at appPage.goto() consistently in
  // CI, never locally, and was unaffected by an explicit per-call timeout
  // -- consistent with CDP-level starvation, not anything in the test's
  // own code). Serializing across files trades CI wall-clock time for not
  // hitting that.
  workers: 1,
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
