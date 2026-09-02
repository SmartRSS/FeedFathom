import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";

const extensionPath = fileURLToPath(
  new URL("../../ext/build-ch", import.meta.url),
);

// Chromium always has chrome.contextMenus, so this can't exercise the
// missing-API path that makes background-event.ts fall back to
// action.setPopup (that's Firefox-for-Android-only and untestable here).
// It instead covers popup.html/popup.ts directly -- the UI mobile actually
// falls back to -- against the chrome.storage.session cache the background
// script keeps regardless of contextMenus support.
test("mobile popup lists a cached feed and opens its preview URL", async ({
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const profile = await mkdtemp(`${tmpdir()}/feedfathom-popup-`);
  const context = await chromium.launchPersistentContext(profile, {
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    channel: "chromium",
    headless: true,
  });

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(serviceWorker.url()).hostname;
    const instance = new URL(baseURL).origin;

    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    const input = optionsPage.locator("#instance");
    await input.fill(instance);
    await input.dispatchEvent("change");
    await optionsPage.waitForFunction(
      async (expected) =>
        (await chrome.storage.sync.get("instance"))["instance"] === expected,
      instance,
    );
    await optionsPage.evaluate(
      async () =>
        await chrome.storage.session.set({
          feedsData: [{ title: "Popup Feed", url: "https://feed.test/rss" }],
        }),
    );

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    const feedButton = popupPage.getByRole("button", { name: "Popup Feed" });
    await expect(feedButton).toBeVisible();

    const [openedPage] = await Promise.all([
      context.waitForEvent("page"),
      feedButton.click(),
    ]);
    const openedUrl = new URL(openedPage.url());
    expect(openedUrl.origin).toBe(instance);
    expect(openedUrl.pathname).toBe("/preview");
    expect(openedUrl.searchParams.get("feedUrl")).toBe("https://feed.test/rss");
  } finally {
    await context.close();
    await rm(profile, { recursive: true });
  }
});

test("mobile popup shows an empty state with no cached feeds", async () => {
  const profile = await mkdtemp(`${tmpdir()}/feedfathom-popup-`);
  const context = await chromium.launchPersistentContext(profile, {
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    channel: "chromium",
    headless: true,
  });

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(serviceWorker.url()).hostname;

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popupPage.locator("#feeds")).toHaveText(
      "No feeds found on this page.",
    );
  } finally {
    await context.close();
    await rm(profile, { recursive: true });
  }
});
