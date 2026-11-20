import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  chromium,
  test as base,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const extensionPath = fileURLToPath(
  new URL("../../ext/build-ch", import.meta.url),
);

type Extension = { context: BrowserContext; id: string };

export const test = base.extend<{
  extension: Extension;
  extensionArgs: string[];
}>({
  extension: async ({ extensionArgs }, use) => {
    const profile = await mkdtemp(`${tmpdir()}/feedfathom-extension-`);
    const context = await chromium.launchPersistentContext(profile, {
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        ...extensionArgs,
      ],
      channel: "chromium",
      headless: true,
    });
    try {
      const serviceWorker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker"));
      await use({ context, id: new URL(serviceWorker.url()).hostname });
    } finally {
      await context.close();
      await rm(profile, { recursive: true });
    }
  },
  extensionArgs: [[], { option: true }],
});

export { expect } from "@playwright/test";

export async function setInstance(
  page: Page,
  extensionId: string,
  instance: string,
) {
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const input = page.getByLabel("Instance");
  await input.fill(instance);
  await input.dispatchEvent("change");
  await page.waitForFunction(
    async (expected) =>
      (await chrome.storage.sync.get("instance"))["instance"] === expected,
    instance,
  );
}
